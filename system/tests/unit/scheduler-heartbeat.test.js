import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { createScheduler } from '../../runtime/daemon/heartbeat.js';

// Tests the bucket-model scheduler. The dispatcher's listDue/runOne/overflow
// semantics now live inside server.js's dispatcherTick (extracted in R-3);
// the scheduler module itself is a generic multi-bucket interval runner.
//
// We use `mock.timers` so the setInterval cadence is driven by `mock.timers.tick`
// instead of real wall time. Combined with a microtask drain after each tick,
// this exercises the same coalescing + concurrent-bucket logic that real time
// would, with sub-millisecond test cost.

async function drainMicrotasks(rounds = 5) {
  for (let i = 0; i < rounds; i++) {
    // Each await yields one microtask round; multiple rounds let chained
    // awaits inside the tick promise resolve.
    await Promise.resolve();
  }
}

function setup() {
  // Note: mock.timers controls setInterval/setTimeout pairs implicitly —
  // enabling setInterval mocks clearInterval too, no need to list separately.
  mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] });
  return () => mock.timers.reset();
}

test('a single dispatcher-style bucket fires its tick on cadence', async () => {
  const cleanup = setup();
  try {
    let calls = 0;
    const sched = createScheduler({
      buckets: [
        {
          name: 'dispatcher',
          intervalMs: 50,
          fireImmediately: true,
          tick: async () => { calls++; },
        },
      ],
    });
    await sched.start();
    await drainMicrotasks(); // drain fireImmediately tick → calls=1
    mock.timers.tick(50); // first interval boundary
    await drainMicrotasks(); // → calls=2
    mock.timers.tick(50); // second interval boundary
    await drainMicrotasks(); // → calls=3
    await sched.stop();
    assert.ok(calls >= 3, `expected >= 3 ticks (1 immediate + 2 interval), got ${calls}`);
  } finally {
    cleanup();
  }
});

test('coalescing prevents overlap when tick is slow', async () => {
  const cleanup = setup();
  try {
    let entered = 0;
    let releaseTick;
    const sched = createScheduler({
      buckets: [
        {
          name: 'slow-dispatcher',
          intervalMs: 30,
          tick: async () => {
            entered++;
            // Block until released so the next interval boundary coalesces.
            await new Promise((r) => { releaseTick = r; });
          },
        },
      ],
    });
    await sched.start();
    // Fire 3 intervals (90ms) while the first tick is still in flight.
    mock.timers.tick(30);
    await drainMicrotasks();
    mock.timers.tick(30);
    await drainMicrotasks();
    mock.timers.tick(30);
    await drainMicrotasks();
    assert.equal(entered, 1, 'second/third ticks coalesced while first is in flight');
    // Release the in-flight promise so stop() can drain.
    releaseTick();
    await sched.stop();
  } finally {
    cleanup();
  }
});

test('independent buckets run concurrently', async () => {
  const cleanup = setup();
  try {
    const seen = new Set();
    const sched = createScheduler({
      buckets: [
        {
          name: 'gmail',
          intervalMs: 50,
          fireImmediately: true,
          tick: async () => { seen.add('gmail'); },
        },
        {
          name: 'lunch',
          intervalMs: 50,
          fireImmediately: true,
          tick: async () => { seen.add('lunch'); },
        },
      ],
    });
    await sched.start();
    await drainMicrotasks();
    await sched.stop();
    assert.ok(seen.has('gmail'));
    assert.ok(seen.has('lunch'));
  } finally {
    cleanup();
  }
});

test('overflow-style fallback runs as its own bucket', async () => {
  const cleanup = setup();
  try {
    let overflow = true;
    let dreamCalls = 0;
    const sched = createScheduler({
      buckets: [
        {
          name: 'dream-overflow',
          intervalMs: 30,
          gate: () => overflow,
          tick: async () => {
            dreamCalls++;
            overflow = false;
          },
        },
      ],
    });
    await sched.start();
    mock.timers.tick(35);
    await drainMicrotasks();
    mock.timers.tick(35);
    await drainMicrotasks();
    await sched.stop();
    assert.ok(dreamCalls >= 1, 'overflow gate let the bucket fire');
    assert.equal(overflow, false);
  } finally {
    cleanup();
  }
});
