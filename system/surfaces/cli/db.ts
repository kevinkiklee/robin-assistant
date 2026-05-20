import { copyFileSync, existsSync, statSync } from 'node:fs';
import Database from 'better-sqlite3';
import { dbFilePath, resolveUserDataDir } from '../../lib/paths.ts';

export function runDbBackup(opts: { path?: string } = {}): void {
  const userData = resolveUserDataDir();
  const src = dbFilePath(userData);
  if (!existsSync(src)) {
    console.error(`No database at ${src}. Run robin init first.`);
    process.exit(2);
  }
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const dst = opts.path ?? `${src}.bak-${ts}`;

  // Use better-sqlite3's online backup. This works even if the daemon is using the DB.
  const db = new Database(src);
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.exec(`VACUUM INTO '${dst.replace(/'/g, "''")}'`);
  } finally {
    db.close();
  }
  const sz = statSync(dst).size;
  console.log(`✓ Backup written to ${dst} (${(sz / 1024 / 1024).toFixed(1)} MB)`);
}

export function runDbRestore(opts: { path: string }): void {
  if (!existsSync(opts.path)) {
    console.error(`Backup file not found: ${opts.path}`);
    process.exit(2);
  }
  const userData = resolveUserDataDir();
  const target = dbFilePath(userData);
  // Atomic-ish: copy to <target>.restoring then rename
  const tmp = `${target}.restoring`;
  copyFileSync(opts.path, tmp);
  // Delete existing then rename
  if (existsSync(target)) {
    copyFileSync(target, `${target}.replaced-${Date.now()}`);
  }
  copyFileSync(tmp, target);
  console.log(`✓ Restored ${opts.path} → ${target}`);
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
