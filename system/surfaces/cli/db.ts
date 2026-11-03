import { copyFileSync, existsSync, statSync } from 'node:fs';
import Database from 'better-sqlite3';
import { dbFilePath, resolveUserDataDir } from '../../lib/paths.ts';

/**
 * Online copy of the SQLite DB at `src` into a new file `dst` (VACUUM INTO). Safe
 * while the daemon or another process holds `src` open: the copy is one
 * consistent read transaction, WAL included. Throws if `dst` already exists.
 */
export function backupDbTo(src: string, dst: string): void {
  const db = new Database(src);
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.exec(`VACUUM INTO '${dst.replace(/'/g, "''")}'`);
  } finally {
    db.close();
  }
}

/** `events` row count through a read-only handle (never converts the journal mode). */
export function countEvents(dbPath: string): number {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    return (db.prepare('SELECT count(*) AS n FROM events').get() as { n: number }).n;
  } finally {
    db.close();
  }
}

/**
 * Jobs the daemon itself holds leased (an in-process job mid-run). Leases held
 * by detached children (`claimed_by = 'child:<pid>'`) are covered by the
 * process drain of `robin cloud` instead.
 */
export const DAEMON_LEASED_SQL =
  "SELECT count(*) AS n FROM jobs WHERE state = 'leased' AND (claimed_by IS NULL OR claimed_by NOT LIKE 'child:%')";

/** {@link DAEMON_LEASED_SQL} against a local DB, read-only; a missing DB holds none. */
export function daemonLeasedJobs(dbPath: string): number {
  if (!existsSync(dbPath)) return 0;
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    return (db.prepare(DAEMON_LEASED_SQL).get() as { n: number }).n;
  } finally {
    db.close();
  }
}

export function runDbBackup(opts: { path?: string } = {}): void {
  const userData = resolveUserDataDir();
  const src = dbFilePath(userData);
  if (!existsSync(src)) {
    console.error(`No database at ${src}. Run robin init first.`);
    process.exit(2);
  }
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const dst = opts.path ?? `${src}.bak-${ts}`;

  backupDbTo(src, dst);
  const sz = statSync(dst).size;
  console.log(`✓ Backup written to ${dst} (${(sz / 1024 / 1024).toFixed(1)} MB)`);
}

/** integration_state keys holding live OAuth credentials (rotating refresh tokens + access tokens). */
const OAUTH_KEY_SQL = `key LIKE '%refresh_token%' OR key LIKE '%access_token%'`;

/**
 * Copy the live DB's OAuth token rows into a restored DB. A backup's refresh
 * token may already have been spent — WHOOP's are single-use and rotate hourly,
 * so restoring any backup older than an hour replays a dead token, which kills
 * the whole token family and forces `robin reauth whoop`. The live rows are
 * always the newest valid ones, so they win. Returns the number of rows carried.
 */
export function carryForwardOAuthState(liveDbPath: string, restoredDbPath: string): number {
  if (!existsSync(liveDbPath)) return 0;
  const live = new Database(liveDbPath, { readonly: true });
  let rows: Array<{ integration_name: string; key: string; value: string; updated_at: string }>;
  try {
    rows = live
      .prepare(
        `SELECT integration_name, key, value, updated_at FROM integration_state WHERE ${OAUTH_KEY_SQL}`,
      )
      .all() as typeof rows;
  } catch {
    return 0;
  } finally {
    live.close();
  }
  if (rows.length === 0) return 0;
  const restored = new Database(restoredDbPath);
  try {
    const upsert = restored.prepare(
      `INSERT INTO integration_state (integration_name, key, value, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(integration_name, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    );
    restored.transaction(() => {
      for (const r of rows) upsert.run(r.integration_name, r.key, r.value, r.updated_at);
    })();
  } finally {
    restored.close();
  }
  return rows.length;
}

/**
 * True when another process still has the DB open. Checkpoints and closes a
 * connection of our own: SQLite deletes the `-wal` file when the last
 * connection closes, so a `-wal` that survives means someone else holds it.
 */
export function dbHeldOpenElsewhere(dbPath: string): boolean {
  if (!existsSync(dbPath)) return false;
  const db = new Database(dbPath);
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
  } finally {
    db.close();
  }
  return existsSync(`${dbPath}-wal`);
}

export function runDbRestore(opts: { path: string }): void {
  if (!existsSync(opts.path)) {
    console.error(`Backup file not found: ${opts.path}`);
    process.exit(2);
  }
  const userData = resolveUserDataDir();
  const target = dbFilePath(userData);
  // Copying over a file another process has open leaves its WAL pointing at the
  // old pages, and its next write corrupts the restored DB.
  if (dbHeldOpenElsewhere(target)) {
    console.error(
      `${target} is open in another process. Stop the daemon (robin daemon uninstall) and quit Claude Code sessions using Robin's MCP servers, then retry.`,
    );
    process.exit(2);
  }
  // Atomic-ish: copy to <target>.restoring then rename
  const tmp = `${target}.restoring`;
  copyFileSync(opts.path, tmp);
  // Delete existing then rename
  if (existsSync(target)) {
    copyFileSync(target, `${target}.replaced-${Date.now()}`);
  }
  const carried = carryForwardOAuthState(target, tmp);
  copyFileSync(tmp, target);
  console.log(`✓ Restored ${opts.path} → ${target}`);
  if (carried > 0)
    console.log(`  Kept ${carried} live OAuth token row(s) (backup tokens may already be spent)`);
  console.log(`  Previous DB saved as ${target}.replaced-<ts>`);
}

export function runDbVacuum(): void {
  const userData = resolveUserDataDir();
  const path = dbFilePath(userData);
  const db = new Database(path);
  try {
    const before = statSync(path).size;
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.exec('VACUUM');
    const after = statSync(path).size;
    console.log(
      `✓ Vacuum complete: ${(before / 1024 / 1024).toFixed(1)} MB → ${(after / 1024 / 1024).toFixed(1)} MB`,
    );
  } finally {
    db.close();
  }
}
