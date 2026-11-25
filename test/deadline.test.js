import assert from 'node:assert/strict';
import test from 'node:test';
import { batchDeadline } from '../deadline.js';

function testClock() {
  let now = 0;
  const pending = new Map();
  return {
    now: () => now,
    set(fn, delay) {
      const handle = Symbol();
      pending.set(handle, { fn, due: now + delay });
      return handle;
    },
    clear: (handle) => pending.delete(handle),
    advance(ms) {
      const end = now + ms;
      while (pending.size) {
        const [next, timer] = [...pending.entries()].sort((a, b) => a[1].due - b[1].due)[0];
        if (timer.due > end) break;
        now = timer.due;
        pending.delete(next);
        timer.fn();
      }
      now = end;
    },
  };
}

test('only elapsed execution consumes the active budget while a matched approval is pending', () => {
  const clock = testClock();
  const deadline = batchDeadline(new AbortController().signal, 200, 2_000, clock);
  clock.advance(120);
  deadline.pause('approval-1');
  clock.advance(500);
  deadline.resume('unrelated');
  assert.equal(deadline.signal.aborted, false);
  deadline.resume('approval-1');
  clock.advance(79);
  assert.equal(deadline.signal.aborted, false);
  clock.advance(1);
  assert.match(deadline.signal.reason.message, /Active execution timed out/);
  deadline.dispose();
});

test('a wall limit applies even if waiting and user stop interrupts immediately', () => {
  const clock = testClock();
  const stop = new AbortController();
  const deadline = batchDeadline(stop.signal, 10, 50, clock);
  deadline.pause('approval-1');
  clock.advance(50);
  assert.match(deadline.signal.reason.message, /wall-clock/);
  deadline.dispose();
  const interrupted = batchDeadline(stop.signal, 10, 50, clock);
  interrupted.pause('approval-2');
  stop.abort();
  assert.match(interrupted.signal.reason.message, /interrupted/);
  interrupted.dispose();
});
