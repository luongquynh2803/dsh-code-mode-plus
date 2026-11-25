import { getQuickJS } from 'quickjs-emscripten';
import { performance } from 'node:perf_hooks';

const MAX_BRIDGE_BYTES = 1024 * 1024;
const MAX_RESULT_BYTES = 64 * 1024;
const MAX_VM_JOBS = 10_000;

// This factory is evaluated inside QuickJS. Its only host capability is the JSON bridge.
function makeRunner(invoke, catalog) {
  const encode = JSON.stringify;
  const decode = JSON.parse;
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const logs = [];
  let logSize = 0;
  let logTruncated = false;
  function log(...items) {
    if (logTruncated) return;
    const text = items.map((item) => typeof item === 'string' ? item : encode(item) ?? String(item)).join(' ');
    const room = 8192 - logSize;
    if (text.length >= room || logs.length >= 100) {
      logTruncated = true;
      return;
    }
    logs.push(text);
    logSize += text.length + 1;
  }

  async function call(name, args) {
    const response = decode(await invoke(name, encode(args)));
    if (response.ok) return response.value;
    const error = new Error(response.error);
    error.name = 'ToolCallError';
    error.toolName = name;
    throw error;
  }

  const tools = Object.create(null);
  for (const name of decode(catalog)) tools[name] = (args) => call(name, args);
  function edit(filePath, oldString, newString, options) {
    if (!tools.edit) throw new Error('edit is not available in this session');
    return tools.edit({ ...options, file_path: filePath, old_string: oldString, new_string: newString });
  }
  function shell(parts, ...values) {
    if (!Array.isArray(parts) || parts.length !== 1 || values.length !== 0 || typeof parts[0] !== 'string') {
      throw new Error('Use $ with a literal Bash command and no substitutions. Use structured file tools for dynamic paths.');
    }
    if (!tools.bash) throw new Error('Bash is not available in this session');
    let dispatched;
    async function run(allowNonzero) {
      dispatched ??= tools.bash({ command: parts[0], description: 'Run Bash command from code batch' });
      const result = await dispatched;
      if (result.kind === 'promoted' || result.kind === 'background') {
        throw new Error('Bash moved to job ' + result.jobId + '; inspect it with the native job tools.');
      }
      if (result.kind !== 'foreground' || result.timedOut || result.aborted || result.signal || result.exitCode === null) {
        throw new Error('Bash did not finish normally');
      }
      if (!allowNonzero && result.exitCode !== 0) {
        throw new Error('Bash exited ' + result.exitCode + ': ' + result.stderr.text.slice(0, 1500));
      }
      return result;
    }
    const facade = (allowNonzero) => ({
      then: (resolve, reject) => run(allowNonzero).then(resolve, reject),
      text: async () => {
        const { stdout } = await run(allowNonzero);
        if (stdout.truncated) throw new Error('Bash stdout was truncated; inspect the result with native tools.');
        return stdout.text;
      },
      lines: async () => {
        const text = await facade(allowNonzero).text();
        return text ? text.replace(/\r?\n$/, '').split(/\r?\n/) : [];
      },
      nothrow: () => facade(true),
    });
    return facade(false);
  }

  Object.defineProperties(globalThis, {
    tools: { value: Object.freeze(tools) },
    edit: { value: edit },
    $: { value: shell },
    console: { value: Object.freeze({ log, info: log, warn: log, error: log, debug: log }) },
  });

  return async (source) => {
    try {
      const value = await new AsyncFunction(source)();
      return encode({ ok: true, logs, logTruncated, value }, (key, item) => {
        if ((item === undefined && key !== 'value') || typeof item === 'function' || typeof item === 'symbol' ||
            (typeof item === 'number' && !Number.isFinite(item))) {
          throw new Error('Return JSON data (no unsupported values)');
        }
        return item;
      });
    } catch (error) {
      return encode({ ok: false, logs, logTruncated, error: String(error).slice(0, 2000) });
    }
  };
}

export async function runGuest(source, bindings, names) {
  const engine = await getQuickJS();
  const runtime = engine.newRuntime();
  const disposables = [];
  const pending = new Map();
  let cpuDeadline = 0;
  const own = (handle) => (disposables.push(handle), handle);
  const withinSlice = (fn) => {
    cpuDeadline = performance.now() + 2000;
    return fn();
  };

  try {
    runtime.setMemoryLimit(32 * 1024 * 1024);
    runtime.setMaxStackSize(512 * 1024);
    runtime.setInterruptHandler(() => performance.now() >= cpuDeadline);
    const vm = own(runtime.newContext());
    const invoke = own(vm.newFunction('invoke', (tool, args) => {
      if (vm.typeof(tool) !== 'string' || vm.typeof(args) !== 'string') throw new Error('Expected JSON tool arguments');
      if (pending.size >= 32) throw new Error('Too many outstanding tool calls');
      const name = vm.getString(tool);
      if (!Object.hasOwn(bindings, name)) throw new Error('Tool is not available to this batch');
      const raw = vm.getString(args);
      if (Buffer.byteLength(raw) > MAX_BRIDGE_BYTES) throw new Error('Tool arguments exceed 1 MiB');
      const parsed = JSON.parse(raw);
      const deferred = vm.newPromise();
      const task = Promise.resolve().then(() => bindings[name](parsed)).then(
        (value) => {
          const json = JSON.stringify({ ok: true, value });
          if (Buffer.byteLength(json) > MAX_BRIDGE_BYTES) throw new Error('Tool result exceeds 1 MiB; narrow its input or inspect the subcall.');
          return json;
        },
      ).catch((error) => JSON.stringify({ ok: false, error: String(error?.message ?? error).slice(0, 2000) }))
        .then((json) => ({ deferred, json }));
      pending.set(deferred, task);
      return deferred.handle;
    }));
    const factory = own(withinSlice(() => vm.unwrapResult(vm.evalCode(`(${makeRunner.toString()})`))));
    const catalog = own(vm.newString(JSON.stringify(names)));
    const run = own(withinSlice(() => vm.unwrapResult(vm.callFunction(factory, vm.undefined, invoke, catalog))));
    const code = own(vm.newString(source));
    const completion = own(withinSlice(() => vm.unwrapResult(vm.callFunction(run, vm.undefined, code))));
    let jobs = 0;

    for (;;) {
      const executed = withinSlice(() => runtime.executePendingJobs(MAX_VM_JOBS - jobs));
      if (executed.error) {
        executed.error.dispose();
        throw new Error('QuickJS interrupted or failed while running promise callbacks');
      }
      jobs += executed.value;
      const state = withinSlice(() => vm.getPromiseState(completion));
      if (state.type === 'fulfilled') {
        const response = own(state.value);
        if (pending.size) throw new Error('The batch returned with unfinished tool calls; await all dispatched calls.');
        if (vm.typeof(response) !== 'string') throw new Error('Invalid QuickJS result');
        const json = vm.getString(response);
        if (Buffer.byteLength(json) > MAX_RESULT_BYTES) throw new Error('Batch result exceeds 64 KiB; select or summarize the data before returning it.');
        return JSON.parse(json);
      }
      if (state.type === 'rejected') {
        state.error.dispose();
        throw new Error('QuickJS could not finish the program; check the program and return JSON data.');
      }
      if (jobs >= MAX_VM_JOBS) throw new Error('QuickJS exhausted its promise-job budget');
      if (!pending.size) throw new Error('The script is waiting on an unresolved promise with no active tool calls');
      const { deferred, json } = await Promise.race(pending.values());
      const value = vm.newString(json);
      try {
        withinSlice(() => deferred.resolve(value));
      } finally {
        value.dispose();
      }
      pending.delete(deferred);
    }
  } finally {
    for (const deferred of pending.keys()) deferred.dispose();
    for (const handle of disposables.reverse()) handle.dispose();
    runtime.dispose();
  }
}
