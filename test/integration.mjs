import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import * as bundle from '../index.js';

const installation = process.env.DSH_INSTALL_DIR;
if (!installation) throw new Error('Set DSH_INSTALL_DIR to the installed @deepseek-ai/dsh package directory first');
const requireFromDsh = createRequire(join(resolve(installation), 'package.json'));
const load = (name) => import(pathToFileURL(requireFromDsh.resolve(`@deepseek-ai/${name}`)).href);
const { Context } = await load('cordis');
const { createScope } = await load('dsh-scope');
const { setApprovalPolicy } = await load('dsh-user-approval');

async function open(t, config = {}, { executionMode = 'per-call', enableJobs = false } = {}) {
  const tmp = await realpath(tmpdir());
  const root = await mkdtemp(join(tmp, 'dsh-code-mode-plus-test-'));
  const ctx = new Context();
  t.after(async () => {
    await ctx.fiber.dispose();
    const target = await realpath(root);
    assert.equal(dirname(target), tmp);
    assert.ok(basename(target).startsWith('dsh-code-mode-plus-test-'));
    assert.equal(target, root);
    await rm(target, { recursive: true });
  });
  const cwd = join(root, 'workspace');
  await mkdir(cwd);
  const mount = async (name, opts = {}) => {
    const module = await load(`dsh-${name}`);
    return await ctx.plugin(module.default ?? module, opts);
  };
  await mount('agent');
  await mount('session');
  await mount('session-projection');
  await mount('system-prompt', { personaPrefix: '' });
  await mount('sandbox-policy', { mode: 'workspace-write', workspaceRoot: cwd });
  await mount('subprocess-local');
  await mount('sandbox-local');
  await mount('fs-sandbox');
  await mount('working-directory', { defaultDirectory: cwd });
  await mount('user-approval', { policy: 'ask' });
  await mount('tools');
  await mount('tool-executor-native');
  await mount('tool-fs', { readImage: false });
  await mount('fs-observation-policy');
  await mount('shell-env');
  await mount('bash-sandbox');
  if (enableJobs) {
    await mount('jobs-local');
    await mount('tool-jobs');
  }
  await mount('tool-bash', { enableRunInBackground: enableJobs });
  await mount('plan-mode', { section: 'Use read-only tools while planning.' });
  await mount('ptc-runtime-node', { executionMode });
  await ctx.plugin(bundle, config);
  const session = ctx.sessions.create(undefined, { meta: { cwd } });
  const agent = { id: session.id, session };
  await ctx.plugin({
    inject: ['agents', 'tools'],
    async apply(owner) {
      agent.ctx = createScope(owner, agent).ctx;
      await agent.ctx.agents.register(agent);
    },
  });
  assert.ok(ctx.tools.get('code_batch', agent), 'bundle tool registered for native agent');
  session.append('turn/start', { turn: 1 });
  session.append('step/start', { turn: 1, step: 1 });
  let count = 0;
  const dispatch = (name, args, signal = new AbortController().signal) => {
    const callId = `fixture-${++count}`;
    session.append('tool/call', { turn: 1, step: 1, name, callId, arguments: JSON.stringify(args) });
    return ctx.tools.execute({
      calls: [{ type: 'tool-call', id: callId, name, arguments: JSON.stringify(args) }],
      signal,
      agent,
    }).then((batch) => batch.results[0].result);
  };
  return {
    ctx, session, cwd, agent,
    run: (code, signal) => dispatch('code_batch', { code, description: 'Exercise the real DSH registry' }, signal),
    events: (type) => session.snapshotEvents().filter((event) => event.type === type).map((event) => event.data),
  };
}

test('coexists with native tools and batches real read, edit and Bash with linked transcript records', async (t) => {
  const { ctx, cwd, run, events } = await open(t);
  assert.ok(ctx.tools.get('read'));
  assert.ok(ctx.tools.get('edit'));
  assert.ok(ctx.tools.get('bash'));
  await writeFile(join(cwd, 'notes.txt'), 'v1\n');
  const outcome = await run([
    'const read = await tools.read({ file_path: "notes.txt" });',
    'await edit(read.path, "v1", "v2");',
    'return { path: read.path, checked: (await $`printf verified`.text()) };',
  ].join('\n'));
  assert.equal(outcome.isError, false, JSON.stringify(outcome));
  assert.equal(await readFile(join(cwd, 'notes.txt'), 'utf8'), 'v2\n');
  assert.equal(outcome.value.result.checked, 'verified');
  assert.equal(outcome.content[0].text.includes('v1'), false);
  const starts = events('tool/ptc-dispatch-start');
  const settled = events('tool/ptc-dispatch');
  assert.deepEqual(starts.map((event) => event.name), ['read', 'edit', 'bash']);
  assert.deepEqual(starts.map((event) => event.subCallId), settled.map((event) => event.subCallId));
  assert.ok(settled.every((event) => event.parentCallId === 'fixture-1' && event.rootCallId === 'fixture-1'));
  assert.ok(settled[1].meta?.diffs.length > 0);
});

test('real approval pauses only the active timer; rejection prevents the edit', async (t) => {
  const { ctx, cwd, run, events } = await open(t, { activeTimeoutMs: 2_000, wallTimeoutMs: 7_000 });
  const file = join(cwd, 'notes.txt');
  await writeFile(file, 'original\n');
  ctx.on('tools/pre-execute', (exec, next) => {
    if (exec.name !== 'edit') return next();
    assert.equal(exec.name, 'edit');
    assert.match(String(exec.callId), /:ptc:\d+$/);
    return { kind: 'ask', reason: 'Test the native approval seam' };
  });
  ctx.on('approval/request', async ({ signal }) => {
    await delay(2_150, undefined, { signal });
    return 'rejected';
  });
  const outcome = await run(`
    await tools.read({ file_path: 'notes.txt' });
    try { await edit('notes.txt', 'original', 'changed'); }
    catch (error) { return { caught: error.name, tool: error.toolName, message: error.message }; }
    return { caught: false };
  `);
  assert.equal(outcome.isError, false, JSON.stringify(outcome));
  assert.equal(outcome.value.result.caught, 'ToolCallError');
  assert.equal(outcome.value.result.tool, 'edit');
  assert.equal(await readFile(file, 'utf8'), 'original\n');
  assert.equal(events('approval/asked')[0].callId, events('tool/ptc-dispatch-start')[1].subCallId);
  assert.equal(events('approval/decided')[0].outcome, 'rejected');
});

test('real file policies apply and native read-before-edit is not bypassed', async (t) => {
  const { cwd, session, run } = await open(t);
  const file = join(cwd, 'notes.txt');
  await writeFile(file, 'v1\n');
  const unread = await run(`await edit('notes.txt', 'v1', 'v2');`);
  assert.equal(unread.isError, true);
  assert.match(unread.error.message, /read/i);
  session.append('sandbox/mode', { mode: 'read-only' });
  setApprovalPolicy(session, 'never');
  const refused = await run(`await tools.read({ file_path: 'notes.txt' }); await edit('notes.txt', 'v1', 'v2');`);
  assert.equal(refused.isError, true);
  assert.match(refused.error.message, /sandbox|permission|read-only/i);
  assert.equal(await readFile(file, 'utf8'), 'v1\n');
});

test('delegated scopes do not see code_batch and plan mode denies its execution', async (t) => {
  const { ctx, session, cwd, agent, run } = await open(t);
  await ctx.plugin({
    inject: ['agents', 'tools'],
    async apply(owner) {
      const childSession = ctx.sessions.create(undefined, { meta: { cwd, origin: 'subagent', delegationDepth: 1 } });
      const child = { id: childSession.id, session: childSession };
      child.ctx = createScope(owner, child, { parent: agent }).ctx;
      await child.ctx.agents.register(child);
      assert.equal(ctx.tools.get('code_batch', child), undefined);
    },
  });
  session.append('plan/mode', { active: true });
  const result = await run('return 1;');
  assert.equal(result.isError, true);
  assert.match(result.error.message, /plan mode/);
});

test('does not leave an auto-promoted shell command running', async (t) => {
  const { ctx, session, run, events } = await open(t, {}, { enableJobs: true });
  const outcome = await run('return await tools.bash({ command: "sleep 5", description: "Test promotion cleanup", timeoutMs: 300 });');
  assert.equal(outcome.isError, true, JSON.stringify(outcome));
  assert.match(outcome.error.message, /moving to a job/);
  const job = events('job/registered')[0];
  assert.ok(job);
  assert.equal(ctx.jobs.get(job.jobId, session.id).status, 'killed');
});

test('optional persistent Node runtime still runs isolated one-shot guests', async (t) => {
  const { run } = await open(t, {}, { executionMode: 'persistent-in-memory' });
  const first = await run('globalThis.remembered = 7; return remembered;');
  assert.equal(first.isError, false, JSON.stringify(first));
  assert.equal(first.value.result, 7);
  const second = await run('return typeof remembered;');
  assert.equal(second.isError, false, JSON.stringify(second));
  assert.equal(second.value.result, 'undefined');
});
