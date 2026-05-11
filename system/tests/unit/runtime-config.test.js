import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
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

test('readConfig returns null when missing', async () => {
  const { readConfig } = await import(`../../config/paths.js?cb=${Date.now()}`);
  assert.equal(await readConfig(), null);
});

test('writeConfig + readConfig round-trip', async () => {
  const { writeConfig, readConfig } = await import(`../../config/paths.js?cb=${Date.now()}`);
  await writeConfig({ embedder_profile: 'mxbai-1024' });
  const cfg = await readConfig();
  assert.equal(cfg.embedder_profile, 'mxbai-1024');
});

test('readConfig throws on malformed JSON', async () => {
  writeFileSync(join(tmpHome, 'config.json'), '{not json', 'utf-8');
  const { readConfig } = await import(`../../config/paths.js?cb=${Date.now()}`);
  await assert.rejects(() => readConfig(), /malformed/);
});

test('writeConfig is atomic temp-rename', async () => {
  const { writeConfig } = await import(`../../config/paths.js?cb=${Date.now()}`);
  await writeConfig({ embedder_profile: 'qwen3-4096' });
  // No .tmp left over
  assert.equal(existsSync(join(tmpHome, 'config.json.tmp')), false);
});
