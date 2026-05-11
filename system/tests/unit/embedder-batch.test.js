import assert from 'node:assert/strict';
import { test } from 'node:test';
import { batchEmbed } from '../../data/embed/embedder.js';

test('batchEmbed with all-success calls inner once at full size', async () => {
  let calls = 0;
  const inner = async (texts) => {
    calls++;
    return texts.map((t) => new Float32Array([t.length]));
  };
  const out = await batchEmbed(inner, ['a', 'bb', 'ccc'], { startSize: 3 });
  assert.equal(calls, 1);
  assert.equal(out.length, 3);
});

test('batchEmbed shrinks on OOM-like errors and retries', async () => {
  const sizes = [];
  const inner = async (texts) => {
    sizes.push(texts.length);
    if (texts.length > 1) throw new Error('out of memory');
    return texts.map((t) => new Float32Array([t.length]));
  };
  const out = await batchEmbed(inner, ['a', 'b', 'c', 'd'], { startSize: 4 });
  // Trace reflects optimistic grow-back: after each success at size 1, size doubles
  // to 2 and is retried. The retry OOMs, halves back to 1, succeeds. Sequence:
  //   i=0 size=4 → OOM, size=2
  //   i=0 size=2 → OOM, size=1
  //   i=0 size=1 → ok, i=1, size=2
  //   i=1 size=2 → OOM, size=1
  //   i=1 size=1 → ok, i=2, size=2
  //   i=2 size=2 → OOM, size=1
  //   i=2 size=1 → ok, i=3, size=2 (slice clamps to 1 since only 1 left)
  //   i=3 size=2 → slice ['d'] (len 1) → ok, i=4
  // Grow-back is intentional: it lets throughput recover after memory pressure passes.
  assert.deepEqual(sizes, [4, 2, 1, 2, 1, 2, 1, 1]);
  assert.equal(out.length, 4);
});

test('batchEmbed throws on non-OOM errors', async () => {
  const inner = async () => {
    throw new Error('something else');
  };
  await assert.rejects(batchEmbed(inner, ['a'], { startSize: 1 }), /something else/);
});
