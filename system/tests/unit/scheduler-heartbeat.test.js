import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createScheduler } from '../../runtime/daemon/heartbeat.js';

// Tests the bucket-model scheduler. The dispatcher's listDue/runOne/overflow
// semantics now live inside server.js's dispatcherTick (extracted in R-3);
// the scheduler module itself is a generic multi-bucket interval runner.

test('a single dispatcher-style bucket fires its tick on cadence', async () => {
  let calls = 0;
  const sched = createScheduler({
    buckets: [
      {
        name: 'dispatcher',
        intervalMs: 50,
        fireImmediately: true,
        tick: async () => {
          calls++;
        },
      },
    ],
  });
  sched.start();
  await new Promise((r) => setTimeout(r, 110));
  sched.stop();
  assert.ok(calls >= 2, `expected >= 2 ticks, got ${calls}`);
});

test('coalescing prevents overlap when tick is slow', async () => {
  let entered = 0;
  const sched = createScheduler({
    buckets: [
      {
        name: 'slow-dispatcher',
        intervalMs: 30,
        tick: async () => {
          entered++;
          await new Promise((r) => setTimeout(r, 200));
        },
      },
    ],
  });
  sched.start();
  await new Promise((r) => setTimeout(r, 100));
  sched.stop();
  assert.equal(entered, 1, 'second tick is coalesced while first is in flight');
});

test('independent buckets run concurrently', async () => {
  const seen = new Set();
  const sched = createScheduler({
    buckets: [
      {
        name: 'gmail',
        intervalMs: 50,
        fireImmediately: true,
        tick: async () => {
          seen.add('gmail');
          await new Promise((r) => setTimeout(r, 100));
        },
      },
      {
        name: 'lunch',
        intervalMs: 50,
        fireImmediately: true,
        tick: async () => {
          seen.add('lunch');
          await new Promise((r) => setTimeout(r, 100));
        },
      },
    ],
  });
  sched.start();
  await new Promise((r) => setTimeout(r, 60));
  sched.stop();
  assert.ok(seen.has('gmail'));
  assert.ok(seen.has('lunch'));
});

test('overflow-style fallback runs as its own bucket', async () => {
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
  sched.start();
  await new Promise((r) => setTimeout(r, 100));
  sched.stop();
  assert.ok(dreamCalls >= 1, 'overflow gate let the bucket fire');
  assert.equal(overflow, false);
});
