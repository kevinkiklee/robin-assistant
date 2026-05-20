import { existsSync } from 'node:fs';
import { closeDb, openDb } from '../../brain/memory/db.ts';
import { allMigrations, applyMigrations } from '../../brain/memory/migrations/index.ts';
import { dbFilePath, resolveUserDataDir } from '../../lib/paths.ts';

export interface UpgradeResult {
  beforeVersion: number;
  afterVersion: number;
  applied: number[];
  backupPath?: string;
}

/**
 * Apply any pending schema migrations to the user's DB.
 * Backs up the DB to <db>.bak-<ts> before applying.
 * Idempotent — if no migrations are pending, does nothing.
 */
export function runUpgrade(opts: { dryRun?: boolean; skipBackup?: boolean } = {}): UpgradeResult {
  const userData = resolveUserDataDir();
  const dbPath = dbFilePath(userData);
  if (!existsSync(dbPath)) {
    console.error(`No database at ${dbPath}. Run robin init first.`);
    process.exit(2);
  }
  const db = openDb(dbPath);
  const row = db.prepare('SELECT MAX(version) as v FROM _migrations').get() as { v: number | null };
  const beforeVersion = row?.v ?? 0;
  const targetVersion = allMigrations[allMigrations.length - 1]?.version ?? 0;
  const pending = allMigrations.filter((m) => m.version > beforeVersion);

  if (pending.length === 0) {
    console.log(`✓ Schema already at version ${beforeVersion}. Nothing to do.`);
    closeDb(db);
    return { beforeVersion, afterVersion: beforeVersion, applied: [] };
  }

  console.log(`Pending migrations: ${pending.map((m) => `${m.version} (${m.name})`).join(', ')}`);
  if (opts.dryRun) {
    closeDb(db);
    console.log('(dry-run; no changes applied)');
    return { beforeVersion, afterVersion: beforeVersion, applied: [] };
  }

  // Back up DB before applying
  let backupPath: string | undefined;
  if (!opts.skipBackup) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    backupPath = `${dbPath}.bak-${ts}`;
    db.pragma('wal_checkpoint(TRUNCATE)');
    // Use VACUUM INTO for a consistent snapshot
    db.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);
    console.log(`✓ Backup: ${backupPath}`);
  }

  const r = applyMigrations(db, allMigrations);
  closeDb(db);
  console.log(`✓ Applied ${r.applied.length} migration(s): ${r.applied.join(', ')}`);
  console.log(`  Schema version: ${beforeVersion} → ${targetVersion}`);
  return { beforeVersion, afterVersion: targetVersion, applied: r.applied, backupPath };
}
