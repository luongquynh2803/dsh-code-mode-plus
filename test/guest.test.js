import assert from 'node:assert/strict';
import test from 'node:test';
import { runGuest } from '../guest.js';

const foreground = (exitCode, stdout = '') => ({
  kind: 'foreground', exitCode, signal: null, timedOut: false, aborted: false,
  stdout: { text: stdout, truncated: false }, stderr: { text: '', truncated: false },
});

test('filters a tool result, applies a native edit, and returns only the requested data', async () => {
  const editCalls = [];
  const result = await runGuest(`
    const value = await tools.read({ file_path: 'a.txt' });
    await edit(value.path, 'v1', 'v2', { replace_all: true });
    console.log('selected', value.path);
    return { changed: value.path };
  `, {
    read: async () => ({ path: 'a.txt', body: 'not automatically returned' }),
    edit: async (args) => { editCalls.push(args); return null; },
  }, ['read', 'edit']);
  assert.deepEqual(editCalls, [{ file_path: 'a.txt', old_string: 'v1', new_string: 'v2', replace_all: true }]);
  assert.deepEqual(result, { ok: true, logs: ['selected a.txt'], logTruncated: false, value: { changed: 'a.txt' } });
});

test('Bash sugar runs one dispatch, surfaces nonzero exit, and can return its stdout explicitly', async () => {
  let calls = 0;
  const result = await runGuest([
    'const command = $`exit 3`;',
    'let failed = false;',
    'try { await command.text(); } catch (error) { failed = error.message.startsWith("Bash exited 3"); }',
    'return { failed, lines: await command.nothrow().lines() };',
  ].join('\n'), { bash: async () => { calls++; return foreground(3, 'a\nb\n'); } }, ['bash']);
  assert.equal(calls, 1);
  assert.deepEqual(result.value, { failed: true, lines: ['a', 'b'] });
});

test('Bash sugar cannot suppress permission errors or interpolate untrusted arguments', async () => {
  let calls = 0;
  const bindings = { bash: async () => { calls++; throw new Error('Permission denied'); } };
  const denied = await runGuest('return await $`pwd`.nothrow();', bindings, ['bash']);
  assert.equal(denied.ok, false);
  assert.match(denied.error, /Permission denied/);
  const substitutions = await runGuest('const path = "a b"; return await $`ls ${path}`.text();', bindings, ['bash']);
  assert.equal(substitutions.ok, false);
  assert.match(substitutions.error, /no substitutions/);
  assert.equal(calls, 1);
});

test('guest has no Node environment, module loader, fetch, or ungranted tools', async () => {
  const result = await runGuest(`
    let canImport = true;
    try { await import('node:fs'); } catch { canImport = false; }
    return { canImport, process: typeof process, require: typeof require, fetch: typeof fetch, bash: typeof tools.bash };
  `, {}, []);
  assert.deepEqual(result.value, { canImport: false, process: 'undefined', require: 'undefined', fetch: 'undefined', bash: 'undefined' });
});

test('settles unfinished pending host bridge handles without running guest continuations', async () => {
  let release;
  const slow = new Promise((resolve) => { release = resolve; });
  let edited = false;
  await assert.rejects(runGuest(`
    tools.read({ file_path: 'a.txt' }).then(() => edit('a.txt', 'x', 'y'));
    return 'done';
  `, { read: async () => slow, edit: async () => { edited = true; return null; } }, ['read', 'edit']), /unfinished tool calls/);
  release(null);
  await slow;
  assert.equal(edited, false);
});

test('rejects oversized output and limits console output', async () => {
  await assert.rejects(runGuest('return "a".repeat(70000);', {}, []), /64 KiB/);
  const result = await runGuest('console.log("ok"); console.log("x".repeat(9000)); return 1;', {}, []);
  assert.deepEqual(result.logs, ['ok']);
  assert.equal(result.logTruncated, true);
});

test('fails a promise with no possible tool wakeup', async () => {
  await assert.rejects(runGuest('await new Promise(() => {});', {}, []), /unresolved promise/);
});
