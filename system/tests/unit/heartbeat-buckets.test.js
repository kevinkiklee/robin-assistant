import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createScheduler } from '../../runtime/daemon/heartbeat.js';

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

test('each bucket runs on its own interval', async () => {
  const calls = { a: 0, b: 0 };
  const sched = createScheduler({
    buckets: [
      {
        name: 'a',
        intervalMs: 30,
        tick: async () => {
          calls.a++;
        },
      },
      {
        name: 'b',
        intervalMs: 60,
        tick: async () => {
          calls.b++;
        },
      },
    ],
  });
  sched.start();
  await wait(200);
  sched.stop();
  assert.ok(calls.a >= 4, `expected a ≥ 4, got ${calls.a}`);
  assert.ok(calls.b >= 2, `expected b ≥ 2, got ${calls.b}`);
  assert.ok(calls.a > calls.b, 'a should tick more often than b');
});

test('fireImmediately runs once at start', async () => {
  let called = 0;
  const sched = createScheduler({
    buckets: [
      {
        name: 'eager',
        intervalMs: 10_000,
        tick: async () => {
          called++;
        },
        fireImmediately: true,
      },
    ],
  });
  sched.start();
  await wait(20);
  sched.stop();
  assert.equal(called, 1);
});

test('default (no fireImmediately) waits for first interval', async () => {
  let called = 0;
  const sched = createScheduler({
    buckets: [
      {
        name: 'lazy',
        intervalMs: 10_000,
        tick: async () => {
          called++;
        },
      },
    ],
  });
  sched.start();
  await wait(20);
  sched.stop();
  assert.equal(called, 0);
});

test('gate returning false skips the tick', async () => {
  let called = 0;
  const sched = createScheduler({
    buckets: [
      {
        name: 'gated',
        intervalMs: 20,
        gate: () => false,
        tick: async () => {
          called++;
        },
      },
    ],
  });
  sched.start();
  await wait(100);
  sched.stop();
  assert.equal(called, 0);
});

test('gate throw is caught and treated as skip', async () => {
  let called = 0;
  const warnings = [];
  const origWarn = console.warn;
  console.warn = (...a) => warnings.push(a.join(' '));
  try {
    const sched = createScheduler({
      buckets: [
        {
          name: 'gate-throws',
          intervalMs: 20,
          gate: () => {
            throw new Error('gate boom');
          },
          tick: async () => {
            called++;
          },
        },
      ],
    });
    sched.start();
    await wait(60);
    sched.stop();
    assert.equal(called, 0);
    assert.ok(
      warnings.some((w) => /scheduler\/gate-throws/.test(w)),
      `expected scheduler/gate-throws warning, got: ${warnings.join('; ')}`,
    );
  } finally {
    console.warn = origWarn;
  }
});

test('tick throw is caught and logged; bucket continues', async () => {
  let called = 0;
  const warnings = [];
  const origWarn = console.warn;
  console.warn = (...a) => warnings.push(a.join(' '));
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
    sched.start();
    await wait(80);
    sched.stop();
    assert.ok(called >= 2, `expected ≥ 2 ticks, got ${called}`);
    assert.ok(
      warnings.some((w) => /scheduler\/crash/.test(w)),
      `expected scheduler/crash warning, got: ${warnings.join('; ')}`,
    );
  } finally {
    console.warn = origWarn;
  }
});

test('overlapping ticks within the same bucket are coalesced', async () => {
  let starts = 0;
  const sched = createScheduler({
    buckets: [
      {
        name: 'slow',
        intervalMs: 20,
        tick: async () => {
          starts++;
          await wait(80);
        },
      },
    ],
  });
  sched.start();
  await wait(120);
  sched.stop();
  // The interval would fire 6 times in 120ms, but each tick takes 80ms.
  // Overlap protection means start count is much less than 6.
  assert.ok(starts < 5, `expected coalesced starts < 5, got ${starts}`);
});

test('stop clears every bucket', async () => {
  const calls = { a: 0 };
  const sched = createScheduler({
    buckets: [
      {
        name: 'a',
        intervalMs: 10,
        tick: async () => {
          calls.a++;
        },
      },
    ],
  });
  sched.start();
  await wait(40);
  const before = calls.a;
  sched.stop();
  await wait(50);
  assert.equal(calls.a, before, 'no ticks after stop');
});

test('throws when buckets is missing or empty', () => {
  assert.throws(() => createScheduler({}), /buckets/);
  assert.throws(() => createScheduler({ buckets: [] }), /buckets/);
});
