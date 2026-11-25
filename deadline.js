import { performance } from 'node:perf_hooks';

export function batchDeadline(signal, activeMs, wallMs, clock = {
  now: () => performance.now(),
  set: (fn, delay) => setTimeout(fn, delay),
  clear: (timer) => clearTimeout(timer),
}) {
  const controller = new AbortController();
  const waiting = new Set();
  let remaining = activeMs;
  let started = clock.now();
  let activeTimer;
  let wallTimer;

  function abort(message) {
    if (!controller.signal.aborted) controller.abort(new Error(message));
    clock.clear(activeTimer);
    clock.clear(wallTimer);
  }

  function arm() {
    started = clock.now();
    if (remaining <= 0) abort('Active execution timed out');
    else activeTimer = clock.set(() => abort('Active execution timed out'), remaining);
  }

  const onAbort = () => abort('Code batch interrupted');
  signal.addEventListener('abort', onAbort, { once: true });
  if (signal.aborted) onAbort();
  else {
    wallTimer = clock.set(() => abort('Code batch reached its wall-clock limit'), wallMs);
    arm();
  }

  return {
    signal: controller.signal,
    abort,
    pause(id) {
      if (controller.signal.aborted || waiting.has(id)) return;
      if (waiting.size === 0) {
        remaining -= clock.now() - started;
        clock.clear(activeTimer);
        if (remaining <= 0) return abort('Active execution timed out');
      }
      waiting.add(id);
    },
    resume(id) {
      if (waiting.delete(id) && waiting.size === 0 && !controller.signal.aborted) arm();
    },
    dispose() {
      signal.removeEventListener('abort', onAbort);
      clock.clear(activeTimer);
      clock.clear(wallTimer);
      waiting.clear();
    },
  };
}
