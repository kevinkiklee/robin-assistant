import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reset } from '../../scripts/cli/reset.js';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function makeRepo() {
  const root = mkdtempSync(join(tmpdir(), 'robin-reset-'));
  mkdirSync(join(root, 'system/scaffold/memory'), { recursive: true });
  writeFileSync(join(root, 'system/scaffold/memory/profile.md'), '# Profile (scaffold)\n');
  mkdirSync(join(root, 'user-data/memory'), { recursive: true });
  writeFileSync(join(root, 'user-data/memory/profile.md'), '# Profile (FILLED IN)\n');
  return root;
}

test('reset wipes user-data and recopies scaffold', async () => {
  const root = makeRepo();
  await reset(root, { confirmed: true, skipBackup: true });
  const restored = readFileSync(join(root, 'user-data/memory/profile.md'), 'utf-8');
  assert.equal(restored, '# Profile (scaffold)\n');
  rmSync(root, { recursive: true, force: true });
});
