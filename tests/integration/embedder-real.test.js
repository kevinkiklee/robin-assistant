import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTransformersEmbedder } from '../../src/embed/embedder.js';

test('real bge-small embedder loads and produces 384-d vectors', { timeout: 120_000 }, async () => {
  const e = await createTransformersEmbedder({ modelId: 'Xenova/bge-small-en-v1.5' });
  assert.equal(e.dimension, 384);
  const v = await e.embed('hello world');
  assert.equal(v.length, 384);
  assert.ok(v instanceof Float32Array);
});
