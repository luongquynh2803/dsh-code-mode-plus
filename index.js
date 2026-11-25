import { batchDeadline } from './deadline.js';

export const inject = ['agents', 'tools', 'ptcRuntime', 'workingDirectory', 'sandboxPolicy', 'sessionProjections'];

const NAME = 'code_batch';
const BASIC_TOOLS = new Set(['read', 'grep', 'glob', 'edit', 'write', 'bash', 'pwsh']);
const SHELL = new Set(['bash', 'pwsh']);
const GUEST_URL = JSON.stringify(new URL('./guest.js', import.meta.url).href);
const MAX_CODE_BYTES = 32 * 1024;
const MAX_LOG_TEXT = 12_000;
const MAX_META_BYTES = 64 * 1024;

const text = (content) => [{ type: 'text', text: content }];
const clip = (value, limit) => value.length > limit
  ? `${value.slice(0, limit - 1_000)}\n[code_batch: output truncated]\n${value.slice(-1_000)}`
  : value;

function supportsTool(registry, agent, name) {
  if (!BASIC_TOOLS.has(name)) return false;
  const definition = registry.get(name, agent);
  return !!definition && (!SHELL.has(name) || definition.output.schema.oneOf?.some(
    (variant) => variant.properties?.kind?.const === 'foreground',
  ));
}

function int(label, value, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${label} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function options(config) {
  const { activeTimeoutMs = 120_000, wallTimeoutMs = 900_000, maxCalls = 24 } = config;
  return {
    activeTimeoutMs: int('activeTimeoutMs', activeTimeoutMs, 1, 600_000),
    wallTimeoutMs: int('wallTimeoutMs', wallTimeoutMs, activeTimeoutMs, 1_800_000),
    maxCalls: int('maxCalls', maxCalls, 1, 100),
  };
}

function supportsAgent(ctx, agent) {
  const { header } = agent.session;
  return header.origin !== 'subagent' && !header.delegationDepth &&
    ctx.agents.roots().includes(agent) && !ctx.tools.get('run_code', agent);
}

function requireNativeMode(ctx, agent) {
  if (!supportsAgent(ctx, agent)) {
    throw new Error('Code Mode Plus is for top-level native agents. Use run_code with the PTC preset.');
  }
  const plan = ctx.sessionProjections.snapshot(agent.session, ['plan']).values.plan;
  if (plan?.active || plan?.pending) {
    throw new Error('Use native read-only tools while in plan mode; code_batch is unavailable there.');
  }
}

function render(_args, value) {
  const out = value.logs.join('\n');
  const result = value.result === undefined ? '' : typeof value.result === 'string' ? value.result : JSON.stringify(value.result);
  const parts = [out, value.logTruncated ? '[code_batch: console log limit reached]' : '', result].filter(Boolean);
  return text(clip(parts.join('\n') || '(code_batch completed with no output)', MAX_LOG_TEXT));
}

function validateInput(args) {
  if (!args || typeof args.code !== 'string' || !args.code.trim() || Buffer.byteLength(args.code) > MAX_CODE_BYTES) {
    throw new Error('code must be a non-empty JavaScript function body of at most 32 KiB');
  }
  if (typeof args.description !== 'string' || !args.description.trim() || args.description.length > 160) {
    throw new Error('description must be a non-empty summary of at most 160 characters');
  }
  if (Object.keys(args).some((key) => key !== 'code' && key !== 'description')) throw new Error('Unexpected code_batch parameter');
}

function logResult(session, head, result) {
  const formatted = clip(result.content.filter((block) => block.type === 'text').map((block) => block.text).join('\n'), MAX_LOG_TEXT);
  const canStoreMeta = result.meta !== undefined && Buffer.byteLength(JSON.stringify(result.meta)) <= MAX_META_BYTES;
  session.append('tool/ptc-dispatch', {
    ...head,
    isError: result.isError,
    content: text(formatted),
    ...(result.error?.info ? { error: result.error.info } : {}),
    ...(canStoreMeta ? { meta: result.meta } : {}),
  });
}

async function stopPromotedJobs(jobs, owner, pending) {
  const outcomes = [];
  for (const id of pending) {
    if (!jobs) {
      outcomes.push(`${id}: job control unavailable`);
      continue;
    }
    try {
      if (jobs.get(id, owner).status === 'running') jobs.kill(id, owner, 'Code Mode Plus does not detach shell jobs');
      const { status } = await jobs.wait(id, 5_000, owner);
      outcomes.push(`${id}: ${status}`);
    } catch {
      outcomes.push(`${id}: stop not verified; check Jobs`);
    }
  }
  return outcomes.join(', ');
}

async function executeBatch(ctx, args, exec, limits, setAbort) {
  validateInput(args);
  if (!exec.agent || exec.parent !== undefined) throw new Error('code_batch must run as a top-level call in an agent session');
  const { agent } = exec;
  requireNativeMode(ctx, agent);
  const { session } = agent;
  const runtime = ctx.ptcRuntime;
  const registry = ctx.tools;
  if (runtime.language !== 'typescript' || runtime.isolation !== 'process' || runtime.sandboxMode === undefined ||
      !['function-body', 'repl'].includes(runtime.programFormat)) {
    throw new Error('Code Mode Plus requires a compatible sandboxed Node PTC runtime');
  }

  const allowed = registry.schemas(agent).filter(({ name }) => supportsTool(registry, agent, name));
  if (!allowed.length) throw new Error('No compatible native tools are visible in this session');
  const deadline = batchDeadline(exec.signal, limits.activeTimeoutMs, limits.wallTimeoutMs);
  setAbort(deadline.abort);
  let nextId = 0;
  let startedCount = 0;
  let settledCount = 0;
  let concluded = false;
  let activeCallId;
  const activeJobs = new Set();
  const jobs = ctx.get('jobs');
  let tail = Promise.resolve();
  let accepting = true;

  const disposeEvents = ctx.on('session/event', (owner, event) => {
    if (owner.id !== session.id) return;
    if (event.type === 'approval/asked' && activeCallId !== undefined && event.data.callId === activeCallId) {
      deadline.pause(event.data.id);
    } else if (event.type === 'approval/decided') {
      deadline.resume(event.data.id);
    } else if (event.type === 'job/registered' && activeCallId !== undefined &&
        event.data.owner === agent.id && event.data.toolCall?.callId === activeCallId &&
        event.data.toolCall.rootCallId === exec.rootCallId) {
      activeJobs.add(event.data.jobId);
    } else if (event.type === 'job/settled') {
      activeJobs.delete(event.data.jobId);
    } else if (['sandbox/mode', 'approval/policy', 'permission/preset', 'plan/mode'].includes(event.type)) {
      deadline.abort('Session permissions or plan mode changed during code_batch');
    }
  });

  const bindings = Object.create(null);
  for (const schema of allowed) {
    const { name } = schema;
    bindings[name] = (argumentsValue) => {
      if (!accepting || deadline.signal.aborted) return Promise.reject(new Error('Code batch is no longer running'));
      if (nextId >= limits.maxCalls) return Promise.reject(new Error(`Code batch tool-call limit (${limits.maxCalls}) reached`));
      const subCallId = `${exec.callId}:ptc:${++nextId}`;
      // Full calls stay serial: the public registry API does not expose PTC's ordered policy scheduler.
      const task = tail.then(async () => {
        deadline.signal.throwIfAborted();
        if (concluded) throw new Error('A previous step concluded the turn');
        requireNativeMode(ctx, agent);
        if (!supportsTool(registry, agent, name)) throw new Error(`${name} is no longer available in this batch`);
        if (!argumentsValue || typeof argumentsValue !== 'object' || Array.isArray(argumentsValue)) {
          throw new Error(`${name} requires a JSON object`);
        }
        if (SHELL.has(name) && argumentsValue.run_in_background === true) {
          throw new Error('Use the native shell tool to explicitly start a background job');
        }
        const head = { rootCallId: exec.rootCallId, parentCallId: exec.callId, subCallId, name, arguments: argumentsValue };
        session.append('tool/ptc-dispatch-start', head);
        startedCount += 1;
        activeCallId = subCallId;
        let result;
        try {
          result = await registry.execute({
            callId: subCallId,
            rootCallId: exec.rootCallId,
            name,
            schema: Object.freeze(schema),
            arguments: argumentsValue,
            agent,
            parent: exec.token,
            signal: deadline.signal,
          });
        } catch (error) {
          const message = String(error?.message ?? error);
          result = { isError: true, error: { message }, content: text(message) };
        } finally {
          activeCallId = undefined;
        }
        const jobsReport = activeJobs.size ? await stopPromotedJobs(jobs, agent.id, [...activeJobs]) : '';
        activeJobs.clear();
        if (SHELL.has(name) && (jobsReport || ['promoted', 'background'].includes(result.value?.kind))) {
          const job = jobsReport || `${result.value.jobId}: stop not verified; check Jobs`;
          const message = `${name} cannot continue inside a batch after moving to a job (${job}). Use the native shell tool for long commands.`;
          result = { isError: true, error: { message }, content: text(message) };
        } else if (SHELL.has(name) && (result.value?.sandbox?.denied || result.value?.sandbox?.runnerFailed)) {
          const message = `${name}: the file sandbox denied the operation or could not run it`;
          result = { isError: true, error: { message }, content: result.content };
        }
        logResult(session, head, result);
        settledCount += 1;
        for (const context of result.additionalContexts ?? []) exec.deferContext(context);
        if (result.isError) throw new Error(result.error.message);
        if (result.concludesTurn) {
          concluded = true;
          exec.concludeTurn();
        }
        return result.value;
      });
      tail = task.catch(() => {});
      return task;
    };
  }

  let result;
  let failure;
  try {
    const policy = ctx.sandboxPolicy.resolve({ session });
    const cwd = await ctx.workingDirectory.ensure(agent, deadline.signal);
    deadline.signal.throwIfAborted();
    requireNativeMode(ctx, agent);
    const invoke = `await runGuest(${JSON.stringify(args.code)}, tools, ${JSON.stringify(allowed.map(({ name }) => name))})`;
    const program = `const { runGuest } = await import(${GUEST_URL});\n${runtime.programFormat === 'repl' ? invoke : `return ${invoke};`}`;
    result = await runtime.run(runtime.resolve({
      program,
      bindings: [{ global: 'tools', functions: bindings }],
      cwd,
      timeoutMs: null,
      sandboxPolicy: policy,
      signal: deadline.signal,
    }));
    deadline.signal.throwIfAborted();
    if (result.error) throw new Error(`${result.error.kind}: ${result.error.message}`);
    if (!result.value || !Array.isArray(result.value.logs) || typeof result.value.ok !== 'boolean') {
      throw new Error('The JavaScript guest did not return a valid result');
    }
    if (!result.value.ok) throw new Error(result.value.error);
  } catch (error) {
    failure = deadline.signal.aborted ? deadline.signal.reason : error;
  } finally {
    accepting = false;
    // The worker cannot own in-flight host calls. Cancel and drain them before returning.
    deadline.abort('Code batch finished');
    try {
      await tail;
    } finally {
      deadline.dispose();
      disposeEvents();
    }
  }

  if (failure) {
    const completed = startedCount ? ` ${settledCount}/${startedCount} started tool calls settled; earlier edits are not rolled back.` : '';
    throw new Error(clip(`code_batch failed: ${failure.message ?? failure}.${completed}\n${result?.value?.logs?.join('\n') ?? ''}`.trimEnd(), MAX_LOG_TEXT));
  }
  return {
    logs: result.value.logs,
    logTruncated: result.value.logTruncated === true,
    ...(Object.hasOwn(result.value, 'value') ? { result: result.value.value } : {}),
  };
}

export function apply(ctx, config = {}) {
  const limits = options(config);
  const active = new Set();
  const scoped = new Map();
  const definition = {
    name: NAME,
    description: 'Batch related native calls or filter their results in JavaScript. Prefer direct tools for one operation. ' +
      'Use an async function body (await, return JSON, console.log). Available bindings are the visible read, grep, glob, edit, write, bash and pwsh tools with their native arguments; each call still checks permissions. ' +
      'Examples: await tools.read({file_path:"notes.md"}); await edit(path, oldText, newText); await $`git status --short`.text(). ' +
      'Bash helper also supports .lines() and .nothrow() for nonzero exit codes, with no template substitutions. Host calls run in order; await all calls. No Node APIs, network APIs, imports, or persistent variables in the program.',
    parameters: {
      type: 'object',
      properties: { code: { type: 'string' }, description: { type: 'string' } },
      required: ['code', 'description'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: { logs: { type: 'array', items: { type: 'string' } }, logTruncated: { type: 'boolean' }, result: {} },
        required: ['logs', 'logTruncated'],
        additionalProperties: false,
      },
      render,
    },
    async execute(args, exec) {
      const entry = {};
      active.add(entry);
      try {
        entry.promise = executeBatch(ctx, args, exec, limits, (abort) => { entry.abort = abort; });
        return await entry.promise;
      } finally {
        active.delete(entry);
      }
    },
  };

  function attach(agent) {
    if (scoped.has(agent)) return;
    try {
      const visible = ctx.tools.get(NAME, agent);
      if (supportsAgent(ctx, agent)) {
        if (!visible && [...BASIC_TOOLS].some((name) => supportsTool(ctx.tools, agent, name))) {
          scoped.set(agent, agent.ctx.tools.register(definition));
        }
      } else if (visible === definition) {
        // Descendants share inherited capabilities unless their scope hides them.
        scoped.set(agent, agent.ctx.tools.restrict({ deny: [NAME] }));
      }
    } catch (error) {
      ctx.logger.warn(`Code Mode Plus could not attach to agent ${agent.id}: ${error.message}`);
    }
  }

  const offCreated = ctx.on('agent/created', ({ agent }) => { attach(agent); });
  const offDisposed = ctx.on('agent/disposed', ({ agent }) => { scoped.delete(agent); });
  for (const agent of ctx.agents.list()) attach(agent);
  ctx.effect(() => async () => {
    offCreated();
    offDisposed();
    for (const run of active) run.abort?.('Code Mode Plus was disabled');
    const disposers = [...scoped.values()].reverse();
    scoped.clear();
    await Promise.allSettled([...disposers.map((dispose) => dispose()), ...[...active].map((run) => run.promise)]);
  }, 'Stop Code Mode Plus batches');
}
