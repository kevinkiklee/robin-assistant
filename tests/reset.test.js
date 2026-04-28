import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reset } from '../core/scripts/reset.js';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function makeRepo() {
  const root = mkdtempSync(join(tmpdir(), 'robin-reset-'));
  mkdirSync(join(root, 'core/skeleton'), { recursive: true });
  writeFileSync(join(root, 'core/skeleton/profile.md'), '# Profile (skeleton)\n');
  mkdirSync(join(root, 'user-data'));
  writeFileSync(join(root, 'user-data/profile.md'), '# Profile (FILLED IN)\n');
  return root;
}

test('reset wipes user-data and recopies skeleton', async () => {
  const root = makeRepo();
  await reset(root, { confirmed: true, skipBackup: true });
  const restored = readFileSync(join(root, 'user-data/profile.md'), 'utf-8');
  assert.equal(restored, '# Profile (skeleton)\n');
  rmSync(root, { recursive: true, force: true });
});
