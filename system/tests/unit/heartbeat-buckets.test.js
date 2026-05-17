import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { createScheduler } from '../../runtime/daemon/heartbeat.js';
import { setSink } from '../../runtime/log/index.js';

// Each test enables mock.timers for setInterval/setTimeout/Date and uses
// `advance()` to step the fake clock in one-interval chunks, draining
// microtasks between each step so the scheduler's async tick promises
// settle before the next interval boundary.

async function drainMicrotasks(rounds = 6) {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

function enableFakeTimers() {
  mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] });
  return () => mock.timers.reset();
}

async function advance(ms, step = 10) {
  // Walk forward in `step`-sized chunks so each interval boundary completes
  // its microtask drain before the next chunk fires.
  let remaining = ms;
  while (remaining > 0) {
    const chunk = Math.min(step, remaining);
    mock.timers.tick(chunk);
    await drainMicrotasks();
    remaining -= chunk;
  }
}

test('each bucket runs on its own interval', async () => {
  const cleanup = enableFakeTimers();
  try {
    const calls = { a: 0, b: 0 };
    const sched = createScheduler({
      buckets: [
        { name: 'a', intervalMs: 30, tick: async () => { calls.a++; } },
        { name: 'b', intervalMs: 60, tick: async () => { calls.b++; } },
      ],
    });
    await sched.start();
    await advance(200);
    await sched.stop();
    assert.ok(calls.a >= 4, `expected a ≥ 4, got ${calls.a}`);
    assert.ok(calls.b >= 2, `expected b ≥ 2, got ${calls.b}`);
    assert.ok(calls.a > calls.b, 'a should tick more often than b');
  } finally {
    cleanup();
  }
});

test('fireImmediately runs once at start', async () => {
  const cleanup = enableFakeTimers();
  try {
    let called = 0;
    const sched = createScheduler({
      buckets: [
        {
          name: 'eager',
          intervalMs: 10_000,
          tick: async () => { called++; },
          fireImmediately: true,
        },
      ],
    });
    await sched.start();
    await drainMicrotasks();
    await sched.stop();
    assert.equal(called, 1);
  } finally {
    cleanup();
  }
});

test('default (no fireImmediately) waits for first interval', async () => {
  const cleanup = enableFakeTimers();
  try {
    let called = 0;
    const sched = createScheduler({
      buckets: [
        { name: 'lazy', intervalMs: 10_000, tick: async () => { called++; } },
      ],
    });
    await sched.start();
    await advance(20);
    await sched.stop();
    assert.equal(called, 0);
  } finally {
    cleanup();
  }
});

test('gate returning false skips the tick', async () => {
  const cleanup = enableFakeTimers();
  try {
    let called = 0;
    const sched = createScheduler({
      buckets: [
        {
          name: 'gated',
          intervalMs: 20,
          gate: () => false,
          tick: async () => { called++; },
        },
      ],
    });
    await sched.start();
    await advance(100);
    await sched.stop();
    assert.equal(called, 0);
  } finally {
    cleanup();
  }
});

test('gate throw is caught and treated as skip', async () => {
  const cleanup = enableFakeTimers();
  let called = 0;
  const lines = [];
  setSink((line) => lines.push(line));
  try {
    const sched = createScheduler({
      buckets: [
        {
          name: 'gate-throws',
          intervalMs: 20,
          gate: () => {
            throw new Error('gate boom');
          },
          tick: async () => { called++; },
        },
      ],
    });
    await sched.start();
    await advance(60);
    await sched.stop();
    assert.equal(called, 0);
    const parsed = lines.map((l) => JSON.parse(l));
    assert.ok(
      parsed.some((e) => e.event === 'scheduler.gate_failed' && e.bucket === 'gate-throws'),
      `expected scheduler.gate_failed event for gate-throws, got: ${lines.join('; ')}`,
    );
  } finally {
    setSink(null);
    cleanup();
  }
});

test('tick throw is caught and logged; bucket continues', async () => {
  const cleanup = enableFakeTimers();
  let called = 0;
  const lines = [];
  setSink((line) => lines.push(line));
  try {
    const sched = createScheduler({
      buckets: [
        {
          name: 'crash',
          intervalMs: 20,
          tick: async () => {
            called++;
            throw new Error('tick boom');
          },
        },
      ],
    });
    await sched.start();
    await advance(80);
    await sched.stop();
    assert.ok(called >= 2, `expected ≥ 2 ticks, got ${called}`);
    const parsed = lines.map((l) => JSON.parse(l));
    assert.ok(
      parsed.some((e) => e.event === 'scheduler.tick_failed' && e.bucket === 'crash'),
      `expected scheduler.tick_failed event for crash, got: ${lines.join('; ')}`,
    );
  } finally {
    setSink(null);
    cleanup();
  }
});

test('overlapping ticks within the same bucket are coalesced', async () => {
  const cleanup = enableFakeTimers();
  try {
    let starts = 0;
    let release;
    const sched = createScheduler({
      buckets: [
        {
          name: 'slow',
          intervalMs: 20,
          tick: async () => {
            starts++;
            // First in-flight: block until released so subsequent intervals coalesce.
            // Subsequent invocations (after release) run fast.
            if (starts === 1) {
              await new Promise((r) => { release = r; });
            }
          },
        },
      ],
    });
    await sched.start();
    // Fire 6 intervals (120ms) while the first tick is in flight. The coalesce
    // branch must suppress 5 of them.
    await advance(120);
    assert.equal(starts, 1, 'in-flight tick must coalesce subsequent intervals');
    release();
    await drainMicrotasks();
    await sched.stop();
  } finally {
    cleanup();
  }
});

test('stop clears every bucket', async () => {
  const cleanup = enableFakeTimers();
  try {
    const calls = { a: 0 };
    const sched = createScheduler({
      buckets: [
        { name: 'a', intervalMs: 10, tick: async () => { calls.a++; } },
      ],
    });
    await sched.start();
    await advance(40);
    const before = calls.a;
    await sched.stop();
    await advance(50);
    assert.equal(calls.a, before, 'no ticks after stop');
  } finally {
    cleanup();
  }
});

test('await stop() drains an in-flight tick before resolving', async () => {
  const cleanup = enableFakeTimers();
  try {
    let finished = false;
    const sched = createScheduler({
      buckets: [
        {
          name: 'slow',
          intervalMs: 1000,
          fireImmediately: true,
          tick: async () => {
            await new Promise((r) => {
              const t = setTimeout(r, 60);
              t.unref?.();
            });
            finished = true;
          },
        },
      ],
    });
    await sched.start();
    // The in-flight tick is awaiting setTimeout(60). Advance the clock so the
    // inner setTimeout fires, then start stop().
    const stopPromise = sched.stop();
    // Drive the clock + microtasks while stop() awaits the in-flight promise.
    mock.timers.tick(60);
    await drainMicrotasks();
    await stopPromise;
    assert.equal(finished, true, 'stop() should not resolve until the in-flight tick completes');
  } finally {
    cleanup();
  }
});

test('throws when buckets is missing or empty', () => {
  assert.throws(() => createScheduler({}), /buckets/);
  assert.throws(() => createScheduler({ buckets: [] }), /buckets/);
});
