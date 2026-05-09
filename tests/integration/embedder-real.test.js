import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTransformersEmbedder } from '../../src/embed/embedder.js';

test('real bge-base embedder loads and produces 768-d vectors', { timeout: 120_000 }, async () => {
  const e = await createTransformersEmbedder({ modelId: 'Xenova/bge-base-en-v1.5' });
  assert.equal(e.dimension, 768);
  const v = await e.embed('hello world');
  assert.equal(v.length, 768);
  assert.ok(v instanceof Float32Array);
});
