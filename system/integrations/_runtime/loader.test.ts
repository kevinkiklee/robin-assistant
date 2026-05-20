import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadIntegrations } from './loader.ts';

function makeTempIntegration(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'robin-int-'));
  const intDir = join(dir, name);
  mkdirSync(intDir, { recursive: true });
  writeFileSync(join(intDir, 'integration.yaml'), `name: ${name}\nversion: 1.0.0\n`);
  writeFileSync(
    join(intDir, 'index.js'),
    `export const integration = { tick: async () => ({ status: 'ok', message: 'from ${name}' }) };\n`,
  );
  return dir;
}

test('loader: skips _underscore + dot dirs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'robin-int-skip-'));
  mkdirSync(join(dir, '_framework'));
  mkdirSync(join(dir, '.hidden'));
  const loaded = await loadIntegrations([dir]);
  assert.equal(loaded.length, 0);
});

test('loader: loads integration with manifest + index.js', async () => {
  const root = makeTempIntegration('demo');
  const loaded = await loadIntegrations([root]);
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].manifest.name, 'demo');
  assert.ok(loaded[0].module.tick);
});
