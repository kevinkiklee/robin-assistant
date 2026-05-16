import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { surql } from 'surrealdb';
import { readDaemonState } from '../../../config/daemon-state.js';
import { ensureHome, getIntegrationDirs, paths } from '../../../config/data-store.js';
import { close, connect, defaultDbUrl } from '../../../data/db/client.js';
import {
  readIntegrationsState,
  setIntegrationEnabled,
  setMigratedAt,
} from '../../../data/runtime/integrations-state.js';
import { loadManifests } from '../../../io/integrations/_framework/manifest-loader.js';
import { isPidAlive } from '../../daemon/lock.js';

// Names that stay in system/io/integrations/. Everything else moves.
const SYSTEM_NAMES = new Set(['gmail', 'google_calendar', 'weather']);

/**
 * Pure entry point — receives ctx (db, dirs, daemon state) and returns
 * { exitCode, stdout, stderr }. The CLI wrapper (integrationsMigrate) opens
 * the DB, resolves dirs and daemon liveness, then delegates here.
 *
 * Semantics:
 *   1. Refuse if `ctx.daemonRunning` is true unless `opts.force`.
 *   2. If `migrated_at` is already set, print "already migrated" and exit 0.
 *   3. Compute auto-enable set: scheduler.integrations keys ∪ scheduler.gateways
 *      keys (or, if `gateways` field absent, every gateway currently in
 *      systemDir as a first-run fallback).
 *   4. WRITE state rows FIRST (`runtime:integrations.states[name]`).
 *   5. Set `migrated_at = now`.
 *   6. Move non-SYSTEM_NAMES dirs from systemDir → userDataDir.
 *   7. Return summary + restart hint via stdout.
 */
export async function runMigrate(ctx, opts = {}) {
  const { db, systemDir, userDataDir } = ctx;
  const stdoutLines = [];
  const stderrLines = [];

  // 1. Refuse while daemon is running unless explicitly forced.
  if (ctx.daemonRunning && !opts.force) {
    stderrLines.push(
      `error: daemon is running on pid ${ctx.daemonPid ?? '<unknown>'} — stop the daemon and re-run, or pass --while-running`,
    );
    return { exitCode: 2, stdout: stdoutLines.join('\n'), stderr: stderrLines.join('\n') };
  }

  // 2. Idempotence — short-circuit if already migrated.
  const existing = await readIntegrationsState(db);
  if (existing.migrated_at && !opts.force) {
    stdoutLines.push(`already migrated at ${new Date(String(existing.migrated_at)).toISOString()}`);
    return { exitCode: 0, stdout: stdoutLines.join('\n'), stderr: stderrLines.join('\n') };
  }

  // 3. Compute the auto-enable set from the scheduler row.
  const [schedRows] = await db
    .query(surql`SELECT * FROM type::record('runtime', 'scheduler')`)
    .collect();
  const schedValue = schedRows[0]?.value ?? {};
  const active = new Set(Object.keys(schedValue.integrations ?? {}));
  if (schedValue.gateways) {
    for (const k of Object.keys(schedValue.gateways)) active.add(k);
  } else {
    // First-run fallback: enable every gateway currently in systemDir.
    const { loaded } = await loadManifests([systemDir]);
    for (const m of loaded) {
      if (m.kind === 'gateway') active.add(m.name);
    }
  }

  // 4. Load manifests from BOTH dirs before moving any files. We need the
  // pre-move view to set `source` correctly per integration.
  const { loaded: preMoveManifests } = await loadManifests([systemDir, userDataDir]);
  const allNames = new Set(preMoveManifests.map((m) => m.name));
  // Belt-and-suspenders: scheduler-known names may have been moved by a
  // partial earlier run with no manifest on disk anymore.
  for (const k of Object.keys(schedValue.integrations ?? {})) allNames.add(k);
  for (const k of Object.keys(schedValue.gateways ?? {})) allNames.add(k);

  // 5. WRITE STATE FIRST. Source reflects post-migration intent:
  // SYSTEM_NAMES → 'system', everything else → 'user-data'.
  for (const name of allNames) {
    const source = SYSTEM_NAMES.has(name) ? 'system' : 'user-data';
    await setIntegrationEnabled(db, name, { enabled: active.has(name), source });
  }
  await setMigratedAt(db, new Date());

  // 6. MOVE FILES SECOND. Anything already at the destination is skipped
  // with a warning so a partial earlier run can be re-tried safely.
  // We iterate over the union of names rather than the de-duped manifest
  // list because the loader collapses system↔user-data collisions to a
  // single entry — but for the move step we need to detect "both sides
  // populated" and warn.
  mkdirSync(userDataDir, { recursive: true });
  let moved = 0;
  let skipped = 0;
  for (const name of allNames) {
    if (SYSTEM_NAMES.has(name)) continue;
    const src = join(systemDir, name);
    const dst = join(userDataDir, name);
    const srcExists = existsSync(src);
    const dstExists = existsSync(dst);
    if (dstExists) {
      stdoutLines.push(`${name}: already at destination, skipped`);
      skipped += 1;
      continue;
    }
    if (!srcExists) continue;
    renameSync(src, dst);
    stdoutLines.push(`${name}: moved`);
    moved += 1;
  }
  stdoutLines.push(`migrated ${moved} integration(s), skipped ${skipped}`);
  stdoutLines.push('restart daemon to load the new layout');
  return { exitCode: 0, stdout: stdoutLines.join('\n'), stderr: stderrLines.join('\n') };
}

export async function integrationsMigrate(args = []) {
  await ensureHome();
  const dirs = getIntegrationDirs();
  const systemDir = dirs[0];
  // `getIntegrationDirs()` omits the user-data dir if it doesn't exist yet —
  // which is exactly the case on a first migrate. Fall back to the canonical
  // location under <home>/io/integrations.
  const userDataDir = dirs[1] ?? join(paths.data.home(), 'io', 'integrations');

  // Detect daemon liveness via the canonical state file path.
  const daemonState = await readDaemonState(paths.data.daemonState());
  const daemonPid = daemonState?.pid;
  const daemonRunning = isPidAlive(daemonPid);

  const db = await connect({ engine: await defaultDbUrl() });
  try {
    const out = await runMigrate(
      { db, systemDir, userDataDir, daemonRunning, daemonPid },
      { force: args.includes('--while-running') },
    );
    if (out.stdout) console.log(out.stdout);
    if (out.stderr) console.error(out.stderr);
    process.exitCode = out.exitCode;
  } finally {
    await close(db);
  }
}
