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
