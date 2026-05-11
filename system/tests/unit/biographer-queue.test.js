import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createBiographerQueue } from '../../cognition/biographer/queue.js';

test('queue processes events sequentially with single worker', async () => {
  const order = [];
  const worker = async (id) => {
    order.push(`start-${id}`);
    await new Promise((r) => setTimeout(r, 10));
    order.push(`end-${id}`);
    return { processed: id };
  };
  const q = createBiographerQueue({ worker });
  const r1 = q.enqueue('a');
  const r2 = q.enqueue('b');
  const r3 = q.enqueue('c');
  await Promise.all([r1, r2, r3]);
  assert.deepEqual(order, ['start-a', 'end-a', 'start-b', 'end-b', 'start-c', 'end-c']);
});

test('concurrent enqueue of same id coalesces (idempotent dedupe)', async () => {
  let calls = 0;
  const worker = async () => {
    calls++;
    return { processed: 1 };
  };
  const q = createBiographerQueue({ worker, dedupe: true });
  const r1 = q.enqueue('same');
  const r2 = q.enqueue('same');
  const r3 = q.enqueue('same');
  await Promise.all([r1, r2, r3]);
  assert.equal(calls, 1, 'dedupe should run worker once');
});

test('worker errors propagate to enqueue caller', async () => {
  const worker = async () => {
    throw new Error('boom');
  };
  const q = createBiographerQueue({ worker });
  await assert.rejects(q.enqueue('x'), /boom/);
});

test('enqueue returns { skipped: true } when at maxPending cap', async () => {
  // Worker that never resolves, so the queue stays full.
  const block = new Promise(() => {});
  const q = createBiographerQueue({
    worker: async () => block,
    dedupe: true,
    maxPending: 2,
  });

  q.enqueue('event-1'); // becomes in-flight; running = true
  q.enqueue('event-2'); // sits in queue array; depth now = 2

  const r3 = q.enqueue('event-3');
  assert.deepEqual(r3, { skipped: true });
});

test('cap path bumps skippedSinceBoot and lastSkippedAt', async () => {
  const block = new Promise(() => {});
  const q = createBiographerQueue({
    worker: async () => block,
    dedupe: true,
    maxPending: 1,
  });
  q.enqueue('a');
  assert.equal(q.skippedSinceBoot, 0);
  assert.equal(q.lastSkippedAt, null);
  const r = q.enqueue('b');
  assert.deepEqual(r, { skipped: true });
  assert.equal(q.skippedSinceBoot, 1);
  assert.ok(q.lastSkippedAt instanceof Date);
});

test('pendingDepth reflects queue + running', async () => {
  const block = new Promise(() => {});
  const q = createBiographerQueue({ worker: async () => block, maxPending: 10 });
  assert.equal(q.pendingDepth, 0);
  q.enqueue('a'); // in-flight
  q.enqueue('b'); // in queue
  q.enqueue('c'); // in queue
  assert.equal(q.pendingDepth, 3);
});

test('dedupe still returns the in-flight promise even at cap', async () => {
  const block = new Promise(() => {});
  const q = createBiographerQueue({
    worker: async () => block,
    dedupe: true,
    maxPending: 1,
  });
  const r1 = q.enqueue('same');
  const r2 = q.enqueue('same'); // dedupe hits BEFORE the cap check
  assert.equal(r1, r2);
});

test('payload object with __queueKey dedupes by that key', async () => {
  let calls = 0;
  const worker = async () => {
    calls++;
    return { processed: 1 };
  };
  const q = createBiographerQueue({ worker, dedupe: true });
  const p1 = { kind: 'batch', source: 'cli', eventIds: ['e1', 'e2'], __queueKey: 'cli:e1,e2' };
  const p2 = { kind: 'batch', source: 'cli', eventIds: ['e1', 'e2'], __queueKey: 'cli:e1,e2' };
  const r1 = q.enqueue(p1);
  const r2 = q.enqueue(p2);
  await Promise.all([r1, r2]);
  assert.equal(calls, 1, 'identical __queueKey should coalesce');
});

test('payload objects with different __queueKey run independently', async () => {
  let calls = 0;
  const worker = async () => {
    calls++;
    return { processed: 1 };
  };
  const q = createBiographerQueue({ worker, dedupe: true });
  const a = { kind: 'batch', source: 'cli', eventIds: ['e1'], __queueKey: 'cli:e1' };
  const b = { kind: 'batch', source: 'discord', eventIds: ['e1'], __queueKey: 'discord:e1' };
  await Promise.all([q.enqueue(a), q.enqueue(b)]);
  assert.equal(calls, 2);
});
