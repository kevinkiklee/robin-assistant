import { spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Copy-verify-delete migration of a Robin home directory.
 *
 * - Always copies first (`cp -a` preserves mode/owner/timestamps).
 * - Verifies the .robin-data marker exists at the target after copy.
 * - Only on success (mode='move'): rm -rf the source.
 * - On any failure: delete the partial target, leave source intact, throw.
 *
 * NEVER uses fs.rename — explicit invariant for cross-filesystem safety.
 *
 * @param {{ from: string, to: string, mode: 'move'|'copy' }} args
 */
export async function migrateHome({ from, to, mode }) {
  if (!from || !to || !mode) {
    throw new TypeError('migrateHome: { from, to, mode } are required');
  }
  if (mode !== 'move' && mode !== 'copy') {
    throw new TypeError(`migrateHome: mode must be 'move' or 'copy' (got ${mode})`);
  }
  if (!existsSync(from)) {
    throw new Error(`migrateHome: source does not exist: ${from}`);
  }
  const parent = dirname(to);
  if (!existsSync(parent)) {
    throw new Error(`migrateHome: target parent does not exist: ${parent}`);
  }
  const cp = spawnSync('cp', ['-a', `${from}/`, to], { stdio: 'pipe' });
  if (cp.status !== 0) {
    if (existsSync(to)) rmSync(to, { recursive: true, force: true });
    const stderr = cp.stderr?.toString('utf8').trim() ?? '(no stderr)';
    throw new Error(`migrateHome: cp -a failed (exit ${cp.status}): ${stderr}`);
  }
  if (!existsSync(`${to}/.robin-data`)) {
    rmSync(to, { recursive: true, force: true });
    throw new Error(`migrateHome: verification failed — .robin-data missing at ${to}`);
  }
  if (mode === 'move') {
    rmSync(from, { recursive: true, force: true });
  }
}
