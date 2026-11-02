import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadIntegrations } from './loader.ts';

function makeIntegration(rootDir: string, dirName: string, manifestName: string) {
  const dir = join(rootDir, dirName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'integration.yaml'), `name: ${manifestName}\nversion: 1.0.0\n`);
  writeFileSync(
    join(dir, 'index.js'),
    `export const integration = { tick: async () => ({ status: 'ok' }) };\n`,
  );
}

test('loader: multi-instance — gmail--work and gmail--personal both load with distinct instanceName', async () => {
  const root = mkdtempSync(join(tmpdir(), 'robin-multi-'));
  makeIntegration(root, 'gmail--work', 'gmail');
  makeIntegration(root, 'gmail--personal', 'gmail');
  const loaded = await loadIntegrations([root]);
  assert.equal(loaded.length, 2);
  const names = loaded.map((l) => l.instanceName).sort();
  assert.deepEqual(names, ['gmail--personal', 'gmail--work']);
  // Both share the same base manifest.name
  for (const l of loaded) {
    assert.equal(l.manifest.name, 'gmail');
  }
});

test('loader: single-instance — directory name matches manifest.name, no instance suffix', async () => {
  const root = mkdtempSync(join(tmpdir(), 'robin-single-'));
  makeIntegration(root, 'gmail', 'gmail');
  const loaded = await loadIntegrations([root]);
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].instanceName, 'gmail');
  assert.equal(loaded[0].manifest.name, 'gmail');
});
