import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createBatchAccumulator } from '../../cognition/biographer/accumulator.js';

function makeConfig(overrides = {}) {
  return () => ({
    max_batch_size: 8,
    debounce_ms: 50,
    max_wait_ms: 300,
    disable: false,
    ...overrides,
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

test('count threshold fires at N events', async () => {
  const fires = [];
  const acc = createBatchAccumulator({
    config: makeConfig({ max_batch_size: 3 }),
    fire: async (eventIds, source) => {
      fires.push({ eventIds: [...eventIds], source });
    },
  });
  acc.add('e1', 'cli');
  acc.add('e2', 'cli');
  acc.add('e3', 'cli');
  await sleep(10);
  assert.equal(fires.length, 1);
  assert.deepEqual(fires[0].eventIds, ['e1', 'e2', 'e3']);
  assert.equal(fires[0].source, 'cli');
});

test('debounce fires after silence', async () => {
  const fires = [];
  const acc = createBatchAccumulator({
    config: makeConfig({ debounce_ms: 30, max_wait_ms: 1000 }),
    fire: async (ids, source) => fires.push({ ids: [...ids], source }),
  });
  acc.add('e1', 'cli');
  await sleep(60);
  assert.equal(fires.length, 1);
  assert.deepEqual(fires[0].ids, ['e1']);
});

test('hard cap fires even under sustained input', async () => {
  const fires = [];
  const acc = createBatchAccumulator({
    config: makeConfig({ debounce_ms: 25, max_wait_ms: 100, max_batch_size: 100 }),
    fire: async (ids, source) => fires.push({ ids: [...ids], source }),
  });
  // Trickle in events every 10 ms so the debounce never expires.
  const start = Date.now();
  let i = 0;
  while (Date.now() - start < 150) {
    acc.add(`e${i++}`, 'cli');
    await sleep(10);
  }
  // After ~150 ms, the hard cap (100 ms) must have fired at least once.
  assert.ok(fires.length >= 1, `expected >=1 fire, got ${fires.length}`);
});

test('source separation: cli and discord events produce two fires', async () => {
  const fires = [];
  const acc = createBatchAccumulator({
    config: makeConfig({ debounce_ms: 30 }),
    fire: async (ids, source) => fires.push({ ids: [...ids], source }),
  });
  acc.add('a', 'cli');
  acc.add('b', 'discord');
  acc.add('c', 'cli');
  acc.add('d', 'discord');
  await sleep(80);
  assert.equal(fires.length, 2);
  const cli = fires.find((f) => f.source === 'cli');
  const disc = fires.find((f) => f.source === 'discord');
  assert.deepEqual(cli.ids, ['a', 'c']);
  assert.deepEqual(disc.ids, ['b', 'd']);
});

test('in-flight bucket does not accept new events; a new bucket opens', async () => {
  const fires = [];
  let resolveFirst;
  const acc = createBatchAccumulator({
    config: makeConfig({ debounce_ms: 20, max_wait_ms: 200 }),
    fire: async (ids, source) => {
      fires.push({ ids: [...ids], source });
      if (fires.length === 1) {
        await new Promise((r) => {
          resolveFirst = r;
        });
      }
    },
  });
  acc.add('a', 'cli');
  await sleep(40);
  // First bucket is in-flight (fire awaiting resolveFirst). Adds open a new bucket.
  acc.add('b', 'cli');
  acc.add('c', 'cli');
  await sleep(50);
  // First bucket fired but second bucket's events were debounced;
  // by 50ms after they were added, the debounce (20ms) has expired.
  assert.equal(fires.length, 2);
  assert.deepEqual(fires[1].ids, ['b', 'c']);
  resolveFirst();
});

test('reads config callback on every flush (operator-tunable at runtime)', async () => {
  const fires = [];
  let cap = 2;
  const acc = createBatchAccumulator({
    config: () => ({ max_batch_size: cap, debounce_ms: 200, max_wait_ms: 500, disable: false }),
    fire: async (ids) => fires.push([...ids]),
  });
  acc.add('a', 'cli');
  acc.add('b', 'cli');
  await sleep(10);
  assert.equal(fires.length, 1);
  cap = 4;
  acc.add('c', 'cli');
  acc.add('d', 'cli');
  acc.add('e', 'cli');
  await sleep(10);
  // Cap is now 4; not yet hit.
  assert.equal(fires.length, 1);
  acc.add('f', 'cli');
  await sleep(10);
  assert.equal(fires.length, 2);
  assert.deepEqual(fires[1], ['c', 'd', 'e', 'f']);
});

test('disable: true short-circuits buckets - each add fires a single-id batch immediately', async () => {
  const fires = [];
  const acc = createBatchAccumulator({
    config: () => ({ max_batch_size: 8, debounce_ms: 200, max_wait_ms: 500, disable: true }),
    fire: async (ids, source) => fires.push({ ids: [...ids], source }),
  });
  acc.add('a', 'cli');
  acc.add('b', 'cli');
  acc.add('c', 'cli');
  await sleep(10);
  // No bucket batching; each event fires on its own.
  assert.equal(fires.length, 3);
  assert.deepEqual(
    fires.map((f) => f.ids),
    [['a'], ['b'], ['c']],
  );
});
