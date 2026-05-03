import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { seedFixture, makeTempdir, cleanupTempdir } from './fixtures.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..', '..');

describe('fixtures', () => {
  let tmp;
  beforeEach(() => { tmp = makeTempdir(); });
  afterEach(() => { if (tmp) rmSync(tmp, { recursive: true, force: true }); });

  it('makeTempdir creates robin-e2e-<uuid> dir under os.tmpdir()', () => {
    assert.ok(existsSync(tmp));
    assert.match(tmp, /robin-e2e-/);
    assert.ok(tmp.startsWith(tmpdir()));
  });

  it('seedFixture with seed=none copies only input/', () => {
    const fixtureDir = mkdtempSync(join(tmpdir(), 'fixt-'));
    mkdirSync(join(fixtureDir, 'input/user-data/memory'), { recursive: true });
    writeFileSync(join(fixtureDir, 'input/user-data/memory/INDEX.md'), 'hello');

    seedFixture({ fixtureDir, seed: 'none', tempdir: tmp });
    assert.equal(readFileSync(join(tmp, 'user-data/memory/INDEX.md'), 'utf8'), 'hello');
    rmSync(fixtureDir, { recursive: true, force: true });
  });

  it('seedFixture with seed=scaffold copies scaffold then overlays input/', () => {
    const fixtureDir = mkdtempSync(join(tmpdir(), 'fixt-'));
    mkdirSync(join(fixtureDir, 'input/user-data/memory'), { recursive: true });
    writeFileSync(join(fixtureDir, 'input/user-data/memory/INDEX.md'), 'OVERRIDE');

    seedFixture({ fixtureDir, seed: 'scaffold', tempdir: tmp, repoRoot: REPO_ROOT });
    // Scaffold-derived file exists.
    assert.ok(existsSync(join(tmp, 'user-data/memory')), 'scaffold memory dir should exist');
    // Override won.
    assert.equal(readFileSync(join(tmp, 'user-data/memory/INDEX.md'), 'utf8'), 'OVERRIDE');
    rmSync(fixtureDir, { recursive: true, force: true });
  });

  it('cleanupTempdir(success=true) deletes the dir', () => {
    cleanupTempdir(tmp, true);
    assert.equal(existsSync(tmp), false);
    tmp = null;
  });

  it('cleanupTempdir(success=false) preserves the dir', () => {
    cleanupTempdir(tmp, false);
    assert.ok(existsSync(tmp));
  });

  it('cleanupTempdir respects KEEP_TEMPDIRS=1', () => {
    process.env.KEEP_TEMPDIRS = '1';
    try {
      cleanupTempdir(tmp, true);
      assert.ok(existsSync(tmp));
    } finally {
      delete process.env.KEEP_TEMPDIRS;
    }
  });
});
