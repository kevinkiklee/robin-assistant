import { copyFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';

/**
 * Read-only snapshot reader for local SQLite databases (Chrome, Slack desktop,
 * Lightroom Classic catalog, etc.). Copies the source file to a temp location,
 * opens it read-only, invokes the caller's queryFn, then deletes the snapshot.
 * SurrealDB remains the sole datastore; better-sqlite3 is used here purely as
 * a transient client lib for vendor-shaped local SQLite files.
 *
 * Imported only by user-data/io/integrations/{lrc,chrome}/sync.js — those
 * files aren't in the package's static import graph, so the dead-code sweep
 * sees this module as orphaned without the dead-code-allowlist entry.
 *
 * @param {object} args
 * @param {string} args.srcPath  Absolute path to the source SQLite file.
 * @param {string} args.cacheDir Directory the snapshot is copied into.
 * @param {string} args.snapshotName Filename prefix for the snapshot.
 * @param {(db: Database) => unknown} args.queryFn Callback that runs queries.
 * @returns {unknown} Whatever queryFn returns.
 */
export function readSqliteSnapshot({ srcPath, cacheDir, snapshotName, queryFn }) {
  if (!existsSync(srcPath)) {
    throw new Error(`source not found: ${srcPath}`);
  }
  mkdirSync(cacheDir, { recursive: true });
  const tmpPath = join(cacheDir, `${snapshotName}-${Date.now()}.sqlite`);
  copyFileSync(srcPath, tmpPath);
  let db;
  try {
    db = new Database(tmpPath, { readonly: true, fileMustExist: true });
    return queryFn(db);
  } finally {
    db?.close();
    try {
      unlinkSync(tmpPath);
    } catch {
      // best-effort cleanup; the OS will reclaim it
    }
  }
}
