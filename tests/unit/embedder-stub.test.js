import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createStubEmbedder } from '../../src/embed/embedder.js';

test('stub embedder produces vectors of the configured dimension', async () => {
  const e = createStubEmbedder({ dimension: 384 });
  const v = await e.embed('hello');
  assert.equal(v.length, 384);
  assert.ok(v instanceof Float32Array);
});

test('stub embedder is deterministic per input', async () => {
  const e = createStubEmbedder({ dimension: 8 });
  const a = await e.embed('robin');
  const b = await e.embed('robin');
  assert.deepEqual(Array.from(a), Array.from(b));
});

test('stub embedder different inputs differ', async () => {
  const e = createStubEmbedder({ dimension: 8 });
  const a = await e.embed('a');
  const b = await e.embed('b');
  assert.notDeepEqual(Array.from(a), Array.from(b));
});

test('embedBatch returns one Float32Array per input', async () => {
  const e = createStubEmbedder({ dimension: 8 });
  const batch = await e.embedBatch(['a', 'b', 'c']);
  assert.equal(batch.length, 3);
  for (const v of batch) assert.equal(v.length, 8);
});
