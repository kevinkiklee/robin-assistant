import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  ensureHome,
  packageRootDir,
  pointerExists,
  readMarker,
  writePointer,
} from '../../src/runtime/data-store.js';

test('interrupt between ensureHome and writePointer: re-running both is idempotent', async () => {
  const home = mkdtempSync(join(tmpdir(), 'robin-interrupt-'));
  process.env.ROBIN_HOME = home;
  // Temporarily stash any existing .robin-home pointer so this test starts clean.
  const pointerPath = join(packageRootDir(), '.robin-home');
  const stash = `${pointerPath}.test-stash`;
  const hadPointer = existsSync(pointerPath);
  if (hadPointer) renameSync(pointerPath, stash);
  try {
    await ensureHome();
    assert.strictEqual(pointerExists(), false);
    const firstMarker = readMarker();
    assert.strictEqual(firstMarker.version, 1);
    await ensureHome();
    writePointer({ home, installedBy: 'test' });
    assert.ok(pointerExists());
    const secondMarker = readMarker();
    assert.deepStrictEqual(firstMarker, secondMarker);
  } finally {
    // biome-ignore lint/performance/noDelete: env vars must be deleted, not assigned undefined
    delete process.env.ROBIN_HOME;
    rmSync(home, { recursive: true, force: true });
    // Restore the original pointer (or remove the test-written one).
    if (existsSync(pointerPath)) rmSync(pointerPath, { force: true });
    if (hadPointer) renameSync(stash, pointerPath);
  }
});
