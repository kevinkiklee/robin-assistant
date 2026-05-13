import { spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Copy-verify-delete migration of a Robin home directory.
 *
 * - Always copies first (`cp -a` preserves mode/owner/timestamps).
 * - Verifies a Robin marker exists at the target after copy. During the v1→v2
 *   transition this accepts EITHER the v2 marker
 *   (`runtime/install/.marker.json`) OR the legacy v1 marker (`.robin-data`).
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
  // Refuse if the target already exists: the failure-cleanup path below does
  // `rmSync(to, recursive)`, which would otherwise destroy pre-existing data
  // (e.g. an aborted prior migration that left the destination populated).
  // Callers must explicitly clear the target before invoking us.
  if (existsSync(to)) {
    throw new Error(`migrateHome: target already exists; refusing to overwrite: ${to}`);
  }
  const cp = spawnSync('cp', ['-a', `${from}/`, to], { stdio: 'pipe' });
  if (cp.status !== 0) {
    if (existsSync(to)) rmSync(to, { recursive: true, force: true });
    const stderr = cp.stderr?.toString('utf8').trim() ?? '(no stderr)';
    throw new Error(`migrateHome: cp -a failed (exit ${cp.status}): ${stderr}`);
  }
  const newMarker = `${to}/runtime/install/.marker.json`;
  const oldMarker = `${to}/.robin-data`;
  if (!existsSync(newMarker) && !existsSync(oldMarker)) {
    rmSync(to, { recursive: true, force: true });
    throw new Error(
      `migrateHome: verification failed — no Robin marker at ${to} ` +
        `(checked runtime/install/.marker.json and .robin-data)`,
    );
  }
  if (mode === 'move') {
    rmSync(from, { recursive: true, force: true });
  }
}
