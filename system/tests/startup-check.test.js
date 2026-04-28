import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runStartupCheck } from '../scripts/startup-check.js';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function repo(populated = true) {
  const root = mkdtempSync(join(tmpdir(), 'robin-su-'));
  mkdirSync(join(root, 'system/skeleton/memory'), { recursive: true });
  mkdirSync(join(root, 'system/migrations'));
  writeFileSync(join(root, 'system/skeleton/memory/profile.md'), '# Profile\n');
  writeFileSync(join(root, 'system/skeleton/robin.config.json'), '{"version":"3.0.0"}');
  writeFileSync(join(root, 'system/CHANGELOG.md'), '## [3.0.0]\n');
  if (populated) {
    mkdirSync(join(root, 'user-data/memory'), { recursive: true });
    writeFileSync(join(root, 'user-data/memory/profile.md'), '# Profile\n');
    writeFileSync(join(root, 'user-data/robin.config.json'), '{"version":"3.0.0"}');
  }
  return root;
}

test('startup-check returns FATAL when user-data/ missing', async () => {
  const root = repo(false);
  const result = await runStartupCheck(root);
  assert.ok(result.findings.some(f => f.level === 'FATAL'));
  rmSync(root, { recursive: true, force: true });
});

test('startup-check auto-copies new skeleton files to user-data', async () => {
  const root = repo(true);
  writeFileSync(join(root, 'system/skeleton/health.md'), '# Health\n');
  await runStartupCheck(root);
  assert.ok(existsSync(join(root, 'user-data/health.md')));
  rmSync(root, { recursive: true, force: true });
});
