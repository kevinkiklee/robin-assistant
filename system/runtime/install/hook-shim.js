import { spawnSync } from 'node:child_process';
import { accessSync, chmodSync, constants, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { packageRootDir } from '../../config/data-store.js';

/**
 * Verify the shipped `bin/robin-hook.sh` shim exists and is mode 755 (or at
 * least executable). If present but not executable, chmod 755 it. Modes can
 * be lost on tarball extraction depending on how npm runs.
 *
 * @returns {Promise<string>} absolute path to the shim
 */
export async function ensureHookShim() {
  const root = packageRootDir();
  const shim = join(root, 'bin', 'robin-hook.sh');
  if (!existsSync(shim)) {
    throw new Error(`hook shim missing: ${shim}`);
  }
  let executable = false;
  try {
    accessSync(shim, constants.X_OK);
    executable = true;
  } catch {
    executable = false;
  }
  if (!executable) {
    chmodSync(shim, 0o755);
  } else {
    // Ensure full 0755 even if user-only-exec was inherited.
    const st = statSync(shim);
    if ((st.mode & 0o777) !== 0o755) {
      try {
        chmodSync(shim, 0o755);
      } catch {
        // Non-fatal: file is already executable, mode bits may be tighter
        // because of umask. Don't clobber on permission errors.
      }
    }
  }
  return shim;
}

/**
 * Probe whether `robin` resolves on PATH from a fresh login shell, and
 * report the absolute shim path. Used by tests + install-time validation
 * to confirm at least one resolution path works for hooks.
 *
 * @returns {Promise<{robinOnPath: boolean, hookShimPath: string}>}
 */
export async function probeHookPath() {
  const shimPath = join(packageRootDir(), 'bin', 'robin-hook.sh');
  const r = spawnSync('/bin/sh', ['-lc', 'command -v robin'], { encoding: 'utf8' });
  const robinOnPath = r.status === 0 && typeof r.stdout === 'string' && r.stdout.trim() !== '';
  return { robinOnPath, hookShimPath: shimPath };
}
