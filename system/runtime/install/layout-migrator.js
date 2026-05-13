// layout-migrator.js — one-shot reshape of <robin_home>/user-data/ from the
// pre-redesign layout (v1) to the faculty-aligned layout (v2).
//
// Triggered automatically by `ensureHome()` in `system/config/data-store.js`.
// A no-op once the marker reports `user_data_layout_version >= 2`.
//
// Design spec: docs/superpowers/specs/2026-05-12-user-data-folder-redesign-design.md

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

const NEW_MARKER_REL = ['runtime', 'install', '.marker.json'];
const OLD_MARKER_REL = ['.robin-data'];
const MIGRATOR_LOCK_REL = ['.layout-migrator.lock'];

const newMarkerPath = (home) => join(home, ...NEW_MARKER_REL);
const oldMarkerPath = (home) => join(home, ...OLD_MARKER_REL);
const lockPathOf = (home) => join(home, ...MIGRATOR_LOCK_REL);

/**
 * @param {string} home  Absolute path to `<robin_home>` (i.e. user-data/).
 * @returns {'v2' | 'v1' | 'fresh'}
 *   - 'v2': already migrated; migrator is a no-op.
 *   - 'v1': legacy layout present; migration needed.
 *   - 'fresh': no marker either place; first-ever install; ensureHome() will
 *     write the v2 marker after creating the dir set.
 */
export function detectLayoutVersion(home) {
  const newPath = newMarkerPath(home);
  if (existsSync(newPath)) {
    try {
      const parsed = JSON.parse(readFileSync(newPath, 'utf8'));
      return parsed?.user_data_layout_version >= 2 ? 'v2' : 'v1';
    } catch {
      return 'v1';
    }
  }
  if (existsSync(oldMarkerPath(home))) return 'v1';
  return 'fresh';
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM means the pid exists but we don't own it — still alive.
    return e.code === 'EPERM';
  }
}

function guardDaemonNotRunning(home) {
  const candidates = [join(home, '.daemon.pid'), join(home, 'runtime', 'daemon', '.pid')];
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    const pid = Number((readFileSync(p, 'utf8') || '').trim());
    if (isPidAlive(pid)) {
      const err = new Error(
        `Layout v1→v2 migration cannot run while the daemon is alive (pid ${pid}). ` +
          'Run "robin daemon stop", then re-run any robin command.',
      );
      err.code = 'LAYOUT_MIGRATOR_DAEMON_RUNNING';
      throw err;
    }
  }
}

function acquireLock(lockPath) {
  // O_EXCL ensures the create-or-fail step is atomic — two concurrent migrators
  // can't both pass an existsSync check and then both write their pid. If the
  // lock already exists, retry exactly once after clearing a stale (dead-pid)
  // lock; that bounds recovery without risking a busy-spin between racing
  // processes.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lockPath, 'wx', 0o644);
      try {
        writeSync(fd, String(process.pid));
      } finally {
        closeSync(fd);
      }
      return;
    } catch (e) {
      if (e?.code !== 'EEXIST') throw e;
    }
    let holder = 0;
    try {
      holder = Number((readFileSync(lockPath, 'utf8') || '0').trim());
    } catch {
      // Lock file vanished between the EEXIST and the read — race resolved in
      // our favour; loop and retry the openSync.
      continue;
    }
    if (isPidAlive(holder)) {
      const err = new Error(
        `layout-migrator: another robin process (pid ${holder}) is migrating; try again shortly.`,
      );
      err.code = 'LAYOUT_MIGRATOR_BUSY';
      throw err;
    }
    try {
      unlinkSync(lockPath);
    } catch {}
  }
  const err = new Error('layout-migrator: could not acquire lock after retry');
  err.code = 'LAYOUT_MIGRATOR_BUSY';
  throw err;
}

function releaseLock(lockPath) {
  try {
    unlinkSync(lockPath);
  } catch {}
}

function isDirEmpty(p) {
  try {
    return readdirSync(p).length === 0;
  } catch {
    return false;
  }
}

// Rename an arbitrary path (file or directory). Idempotent with respect to
// prior partial runs: if `newPath` already exists and `oldPath` is gone or
// empty, treat as already-moved.
function moveEntry(oldPath, newPath, { dryRun, log } = {}) {
  if (!existsSync(oldPath)) {
    if (existsSync(newPath)) log?.(`skip (already moved): ${oldPath} → ${newPath}`);
    return;
  }
  if (existsSync(newPath)) {
    if (isDirEmpty(newPath)) {
      log?.(`rmdir-then-rename: ${oldPath} → ${newPath}`);
      if (!dryRun) {
        rmdirSync(newPath);
        renameSync(oldPath, newPath);
      }
      return;
    }
    if (isDirEmpty(oldPath)) {
      log?.(`rmdir (old empty after prior run): ${oldPath}`);
      if (!dryRun) {
        try {
          rmdirSync(oldPath);
        } catch {}
      }
      return;
    }
    const err = new Error(
      `layout-migrator: both ${oldPath} and ${newPath} are non-empty — resolve manually`,
    );
    err.code = 'LAYOUT_MIGRATOR_CONFLICT';
    throw err;
  }
  log?.(`rename: ${oldPath} → ${newPath}`);
  if (!dryRun) {
    mkdirSync(dirname(newPath), { recursive: true });
    renameSync(oldPath, newPath);
  }
}

// File-only rename. Skips if the source is absent or the target already exists
// (treated as already-moved).
function moveFile(oldPath, newPath, { dryRun, log } = {}) {
  if (!existsSync(oldPath)) return;
  if (existsSync(newPath)) {
    log?.(`skip (already moved): ${oldPath} → ${newPath}`);
    return;
  }
  log?.(`rename: ${oldPath} → ${newPath}`);
  if (!dryRun) {
    mkdirSync(dirname(newPath), { recursive: true });
    renameSync(oldPath, newPath);
  }
}

// Move every entry in `srcDir` that matches `predicate` into `destDir`.
function moveGlob(srcDir, predicate, destDir, { dryRun, log } = {}) {
  if (!existsSync(srcDir)) return;
  let entries;
  try {
    entries = readdirSync(srcDir);
  } catch {
    return;
  }
  if (!dryRun) mkdirSync(destDir, { recursive: true });
  for (const entry of entries) {
    if (!predicate(entry)) continue;
    const src = join(srcDir, entry);
    const dst = join(destDir, entry);
    if (existsSync(dst)) {
      log?.(`skip (already moved): ${src} → ${dst}`);
      continue;
    }
    log?.(`rename: ${src} → ${dst}`);
    if (!dryRun) renameSync(src, dst);
  }
}

function tryRmdir(p, { dryRun, log } = {}) {
  if (!existsSync(p)) return;
  if (!isDirEmpty(p)) return;
  log?.(`rmdir: ${p}`);
  if (!dryRun) {
    try {
      rmdirSync(p);
    } catch {}
  }
}

/**
 * Run the v1→v2 layout migration. No-op when already v2 or fresh.
 *
 * @param {string} home  Absolute `<robin_home>` path.
 * @param {{ dryRun?: boolean, log?: (msg: string) => void }} [opts]
 * @returns {Promise<{ migrated: boolean, reason?: 'v2' | 'fresh', dryRun?: boolean }>}
 */
export async function migrateUserDataLayout(home, opts = {}) {
  const { dryRun = false, log } = opts;
  const state = detectLayoutVersion(home);
  if (state === 'v2') return { migrated: false, reason: 'v2' };
  if (state === 'fresh') return { migrated: false, reason: 'fresh' };

  // state === 'v1' — proceed with migration.
  guardDaemonNotRunning(home);

  const lockPath = lockPathOf(home);
  if (!dryRun) acquireLock(lockPath);

  try {
    const ctx = { dryRun, log };

    // 1. db/ → data/db/  (largest single move; do first while the daemon-guard is fresh)
    moveEntry(join(home, 'db'), join(home, 'data', 'db'), ctx);

    // 2. cache/logs/* → runtime/logs/*
    moveGlob(join(home, 'cache', 'logs'), () => true, join(home, 'runtime', 'logs'), ctx);

    // 3. cache/v1-import-report-*.json → runtime/install/reports/
    moveGlob(
      join(home, 'cache'),
      (n) => n.startsWith('v1-import-report-') && n.endsWith('.json'),
      join(home, 'runtime', 'install', 'reports'),
      ctx,
    );

    // 4. cache/sqlite-snapshots/ → io/sqlite-snapshots/
    moveEntry(join(home, 'cache', 'sqlite-snapshots'), join(home, 'io', 'sqlite-snapshots'), ctx);

    // 4b. backup/*.tar (and any other contents) → data/snapshots/. The
    // dir-rename `moveEntry` would suffice on a fresh v1 home, but
    // ensureHome's mkdir of data/snapshots/ frequently runs alongside
    // the migrator on test instances, so we file-by-file the contents
    // instead. Empty backup/ is no-op; rmdir is handled in step 13.
    moveGlob(join(home, 'backup'), () => true, join(home, 'data', 'snapshots'), ctx);

    // 5. runtime/state/published/index.jsonl → io/publish/index.jsonl
    moveFile(
      join(home, 'runtime', 'state', 'published', 'index.jsonl'),
      join(home, 'io', 'publish', 'index.jsonl'),
      ctx,
    );

    // 6. runtime/state/telemetry/publish.log → runtime/logs/publish.log
    moveFile(
      join(home, 'runtime', 'state', 'telemetry', 'publish.log'),
      join(home, 'runtime', 'logs', 'publish.log'),
      ctx,
    );

    // 7. runtime/state/recall-reinforce-last-run.json → cognition/reinforcement-last-run.json
    moveFile(
      join(home, 'runtime', 'state', 'recall-reinforce-last-run.json'),
      join(home, 'cognition', 'reinforcement-last-run.json'),
      ctx,
    );

    // 8. runtime/state/daemon-status.json → runtime/daemon/status.json
    moveFile(
      join(home, 'runtime', 'state', 'daemon-status.json'),
      join(home, 'runtime', 'daemon', 'status.json'),
      ctx,
    );

    // 9. Root JSONs and dotfiles (excluding the legacy marker — handled in step 12).
    moveFile(join(home, 'config.json'), join(home, 'config', 'config.json'), ctx);
    moveFile(join(home, 'manifest.json'), join(home, 'runtime', 'install', 'manifest.json'), ctx);
    moveFile(
      join(home, 'host-integrations.json'),
      join(home, 'runtime', 'install', 'host-integrations.json'),
      ctx,
    );
    moveFile(join(home, '.daemon.pid'), join(home, 'runtime', 'daemon', '.pid'), ctx);
    moveFile(join(home, '.daemon.state'), join(home, 'runtime', 'daemon', '.state'), ctx);
    moveFile(join(home, '.daemon.lock'), join(home, 'runtime', 'daemon', '.lock'), ctx);
    moveFile(join(home, '.manifest.lock'), join(home, 'runtime', 'install', '.manifest.lock'), ctx);

    // 10. secrets/ → config/secrets/
    moveEntry(join(home, 'secrets'), join(home, 'config', 'secrets'), ctx);

    // 11. skills/external/* → skills/*
    moveGlob(join(home, 'skills', 'external'), () => true, join(home, 'skills'), ctx);

    // 12. Marker write: preserve createdAt from legacy, write the v2 marker, unlink the old.
    const now = new Date().toISOString();
    let createdAt = now;
    const oldMarker = oldMarkerPath(home);
    if (existsSync(oldMarker)) {
      try {
        const legacy = JSON.parse(readFileSync(oldMarker, 'utf8'));
        if (typeof legacy?.createdAt === 'string') createdAt = legacy.createdAt;
      } catch {}
    }
    const newMarker = newMarkerPath(home);
    log?.(`write marker: ${newMarker}`);
    if (!dryRun) {
      mkdirSync(dirname(newMarker), { recursive: true });
      writeFileSync(
        newMarker,
        JSON.stringify({ user_data_layout_version: 2, migrated_at: now, createdAt }, null, 2),
        { mode: 0o644 },
      );
      if (existsSync(oldMarker)) {
        try {
          unlinkSync(oldMarker);
        } catch {}
      }
    }

    // 13. Best-effort cleanup of now-empty legacy directories.
    tryRmdir(join(home, 'cache', 'logs'), ctx);
    tryRmdir(join(home, 'cache'), ctx);
    tryRmdir(join(home, 'backup'), ctx);
    tryRmdir(join(home, 'runtime', 'state', 'published'), ctx);
    tryRmdir(join(home, 'runtime', 'state', 'telemetry'), ctx);
    tryRmdir(join(home, 'runtime', 'state'), ctx);
    tryRmdir(join(home, 'sources', 'media'), ctx);
    tryRmdir(join(home, 'skills', 'external'), ctx);

    return { migrated: true, dryRun };
  } finally {
    if (!dryRun) releaseLock(lockPath);
  }
}

/**
 * Names of stray legacy directories at the home root. Doctor uses this to
 * flag incomplete cleanup.
 */
export const LEGACY_STRAY_DIRS = Object.freeze([
  'cache',
  'backup',
  'secrets',
  'db',
  'runtime/state',
  'sources/media',
  'skills/external',
]);
