import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createScheduler } from '../../src/daemon/scheduler.js';

test('scheduler heartbeat fires runDream when next_run_at is past-due', async () => {
  let runDreamCalls = 0;
  let nextRunAt = new Date(Date.now() - 1000); // past
  const scheduler = createScheduler({
    runDream: async () => {
      runDreamCalls++;
    },
    isOverflow: async () => false,
    getCronHour: () => 4,
    readNextRunAt: async () => nextRunAt,
    writeNextRunAt: async (d) => {
      nextRunAt = d;
    },
    heartbeatMs: 50,
  });
  scheduler.start();
  await new Promise((r) => setTimeout(r, 100));
  scheduler.stop();
  assert.ok(runDreamCalls >= 1);
});

test('scheduler heartbeat fires runDream on overflow', async () => {
  let runDreamCalls = 0;
  let overflow = true;
  const scheduler = createScheduler({
    runDream: async () => {
      runDreamCalls++;
      overflow = false;
    },
    isOverflow: async () => overflow,
    getCronHour: () => 4,
    readNextRunAt: async () => new Date(Date.now() + 86400_000),
    writeNextRunAt: async () => {},
    heartbeatMs: 50,
  });
  scheduler.start();
  await new Promise((r) => setTimeout(r, 150));
  scheduler.stop();
  assert.ok(runDreamCalls >= 1);
});

test('scheduler does not run when in flight', async () => {
  let runDreamCalls = 0;
  const scheduler = createScheduler({
    runDream: async () => {
      runDreamCalls++;
      await new Promise((r) => setTimeout(r, 200));
    },
    isOverflow: async () => false,
    getCronHour: () => 4,
    readNextRunAt: async () => new Date(Date.now() - 1000),
    writeNextRunAt: async () => {},
    heartbeatMs: 30,
  });
  scheduler.start();
  await new Promise((r) => setTimeout(r, 100));
  scheduler.stop();
  assert.equal(runDreamCalls, 1);
});
