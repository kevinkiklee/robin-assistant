import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

let tmpHome;
test.beforeEach(() => {
  tmpHome = join(tmpdir(), `robin-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpHome, { recursive: true });
  process.env.ROBIN_HOME = tmpHome;
});
test.afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

test('createEmbedder throws when config is missing', async () => {
  const { createEmbedder } = await import(`../../data/embed/factory.js?cb=${Date.now()}`);
  await assert.rejects(() => createEmbedder(), /no embedder profile configured/);
});

test('createEmbedder throws on unknown profile', async () => {
  const { writeConfig } = await import(`../../config/paths.js?cb=${Date.now()}`);
  await writeConfig({ embedder_profile: 'unknown-xxx' });
  const { createEmbedder } = await import(`../../data/embed/factory.js?cb=${Date.now()}`);
  await assert.rejects(() => createEmbedder(), /unknown embedder profile/);
});
