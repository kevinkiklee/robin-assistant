import { mkdirSync, cpSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

export function makeTempdir() {
  const dir = join(tmpdir(), `robin-e2e-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * @param {{
 *   fixtureDir: string,    // absolute path to system/tests/fixtures/<sub>/<name>/
 *   seed: 'none' | 'scaffold',
 *   tempdir: string,       // destination
 *   repoRoot?: string,     // package root, needed for seed='scaffold'
 * }} opts
 */
export function seedFixture({ fixtureDir, seed, tempdir, repoRoot }) {
  if (seed === 'scaffold') {
    if (!repoRoot) throw new Error('seed=scaffold requires repoRoot');
    const scaffold = join(repoRoot, 'system/scaffold');
    if (!existsSync(scaffold)) {
      throw new Error(`scaffold not found at ${scaffold}`);
    }
    cpSync(scaffold, join(tempdir, 'user-data'), { recursive: true, errorOnExist: false });
  }
  const inputDir = join(fixtureDir, 'input');
  if (existsSync(inputDir)) {
    cpSync(inputDir, tempdir, { recursive: true, force: true });
  }
}

export function cleanupTempdir(path, success) {
  if (process.env.KEEP_TEMPDIRS === '1') {
    process.stderr.write(`KEEP_TEMPDIRS: ${path}\n`);
    return;
  }
  if (success) {
    rmSync(path, { recursive: true, force: true });
  } else {
    process.stderr.write(`tempdir preserved (failure): ${path}\n`);
  }
}
