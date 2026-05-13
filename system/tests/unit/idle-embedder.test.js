import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createIdleEmbedder } from '../../runtime/daemon/idle-embedder.js';

test('idle embedder loads on first use; unloads after timeout', async () => {
  let loadCount = 0;
  const factory = async () => {
    loadCount++;
    return { dimension: 1024, embed: async () => new Float32Array(1024) };
  };
  const ie = createIdleEmbedder({ factory, idleMs: 50 });
  const e1 = await ie.get();
  await e1.embed('a');
  ie.touch();
  await new Promise((r) => setTimeout(r, 200));
  const e2 = await ie.get();
  assert.ok(e2);
  assert.equal(loadCount, 2);
  ie.shutdown();
});

test('repeated touches keep embedder alive', async () => {
  let loadCount = 0;
  const factory = async () => {
    loadCount++;
    return { dimension: 1024 };
  };
  const ie = createIdleEmbedder({ factory, idleMs: 100 });
  await ie.get();
  for (let i = 0; i < 5; i++) {
    ie.touch();
    await new Promise((r) => setTimeout(r, 30));
  }
  await ie.get();
  assert.equal(loadCount, 1);
  ie.shutdown();
});

test('concurrent get() calls share one factory load (no duplicate embedders)', async () => {
  let loadCount = 0;
  const factory = async () => {
    loadCount++;
    // Simulate a slow load so the second call sees the in-flight state.
    await new Promise((r) => setTimeout(r, 20));
    return { dimension: 1024, id: loadCount };
  };
  const ie = createIdleEmbedder({ factory, idleMs: 10_000 });
  const [a, b, c] = await Promise.all([ie.get(), ie.get(), ie.get()]);
  assert.equal(loadCount, 1, 'factory called exactly once across concurrent get() calls');
  assert.strictEqual(a, b, 'concurrent callers see the same instance');
  assert.strictEqual(b, c);
  ie.shutdown();
});
