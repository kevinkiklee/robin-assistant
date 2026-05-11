import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createScheduler } from '../../runtime/daemon/heartbeat.js';

test('scheduler fires runOne for due items', async () => {
  let calls = 0;
  const scheduler = createScheduler({
    listDue: async () => [{ name: '__dream__', kind: 'dream' }],
    runOne: async () => {
      calls++;
    },
    isOverflow: async () => false,
    heartbeatMs: 50,
  });
  scheduler.start();
  await new Promise((r) => setTimeout(r, 100));
  scheduler.stop();
  assert.ok(calls >= 1);
});

test('scheduler fires runOne(__dream__) on overflow when nothing else due', async () => {
  let calls = 0;
  let overflow = true;
  const scheduler = createScheduler({
    listDue: async () => [],
    runOne: async (name) => {
      if (name === '__dream__') {
        calls++;
        overflow = false;
      }
    },
    isOverflow: async () => overflow,
    heartbeatMs: 50,
  });
  scheduler.start();
  await new Promise((r) => setTimeout(r, 150));
  scheduler.stop();
  assert.ok(calls >= 1);
});

test('scheduler does not double-run same name while in flight', async () => {
  let calls = 0;
  const scheduler = createScheduler({
    listDue: async () => [{ name: 'gmail', kind: 'integration' }],
    runOne: async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 200));
    },
    isOverflow: async () => false,
    heartbeatMs: 30,
  });
  scheduler.start();
  await new Promise((r) => setTimeout(r, 100));
  scheduler.stop();
  assert.equal(calls, 1);
});

test('scheduler runs different names concurrently', async () => {
  const calls = [];
  const scheduler = createScheduler({
    listDue: async () => [
      { name: 'gmail', kind: 'integration' },
      { name: 'lunch_money', kind: 'integration' },
    ],
    runOne: async (name) => {
      calls.push(name);
      await new Promise((r) => setTimeout(r, 100));
    },
    isOverflow: async () => false,
    heartbeatMs: 50,
  });
  scheduler.start();
  await new Promise((r) => setTimeout(r, 60));
  scheduler.stop();
  assert.equal(calls.length, 2);
  assert.ok(calls.includes('gmail'));
  assert.ok(calls.includes('lunch_money'));
});
