import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createInProcessEmbedder } from '../../data/embed/in-process.js';

// Slow group: actual model loading is ~30s cold, ~1s warm. `pnpm test:fast`
// sets ROBIN_SKIP_SLOW=1 to skip them during inner-loop iteration. CI and
// `pnpm test` still run them.
const SKIP_SLOW = process.env.ROBIN_SKIP_SLOW === '1';

test('createInProcessEmbedder returns Embedder shape', async () => {
  const e = await createInProcessEmbedder();
  assert.equal(e.profile, 'mxbai-1024');
  assert.equal(e.dimension, 1024);
  assert.equal(typeof e.embed, 'function');
  assert.equal(typeof e.embedBatch, 'function');
  assert.equal(typeof e.healthCheck, 'function');
  assert.equal(typeof e.unload, 'function');
});

test('embed() returns 1024-dim Float32Array', { skip: SKIP_SLOW, timeout: 60_000 }, async () => {
  const e = await createInProcessEmbedder();
  const v = await e.embed('hello world');
  assert.ok(v instanceof Float32Array);
  assert.equal(v.length, 1024);
});

test('embedBatch() returns array of 1024-dim Float32Arrays', {
  skip: SKIP_SLOW,
  timeout: 60_000,
}, async () => {
  const e = await createInProcessEmbedder();
  const vs = await e.embedBatch(['a', 'b', 'c']);
  assert.equal(vs.length, 3);
  for (const v of vs) assert.equal(v.length, 1024);
});

test('unload() drops extractor reference', { skip: SKIP_SLOW }, async () => {
  const e = await createInProcessEmbedder();
  await e.unload();
});

test('healthCheck() resolves immediately for in-process', { skip: SKIP_SLOW }, async () => {
  const e = await createInProcessEmbedder();
  await e.healthCheck();
});
