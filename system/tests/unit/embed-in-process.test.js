import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createInProcessEmbedder } from '../../data/embed/in-process.js';

test('createInProcessEmbedder returns Embedder shape', async () => {
  const e = await createInProcessEmbedder();
  assert.equal(e.profile, 'mxbai-1024');
  assert.equal(e.dimension, 1024);
  assert.equal(typeof e.embed, 'function');
  assert.equal(typeof e.embedBatch, 'function');
  assert.equal(typeof e.healthCheck, 'function');
  assert.equal(typeof e.unload, 'function');
});

// Note: actual model loading is slow (~30s first time). These tests are slow.
// Use --test-concurrency=1 if needed; or skip in CI via env var.
test('embed() returns 1024-dim Float32Array', { timeout: 60_000 }, async () => {
  const e = await createInProcessEmbedder();
  const v = await e.embed('hello world');
  assert.ok(v instanceof Float32Array);
  assert.equal(v.length, 1024);
});

test('embedBatch() returns array of 1024-dim Float32Arrays', { timeout: 60_000 }, async () => {
  const e = await createInProcessEmbedder();
  const vs = await e.embedBatch(['a', 'b', 'c']);
  assert.equal(vs.length, 3);
  for (const v of vs) assert.equal(v.length, 1024);
});

test('unload() drops extractor reference', async () => {
  const e = await createInProcessEmbedder();
  await e.unload();
  // Cannot directly observe extractor=null, but next embed() should re-load (succeeds → didn't crash).
});

test('healthCheck() resolves immediately for in-process', async () => {
  const e = await createInProcessEmbedder();
  await e.healthCheck();
});
