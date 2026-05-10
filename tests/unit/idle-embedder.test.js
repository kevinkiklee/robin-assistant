import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createIdleEmbedder } from '../../src/daemon/idle-embedder.js';

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
