import { readFileSync, writeFileSync, existsSync, cpSync, rmSync, readdirSync } from 'fs';
import { join } from 'path';
import { findConfig } from './lib/find-config.js';
import { migrateConfigFilename } from './lib/migrate-config-filename.js';
import { SYSTEM_FILES } from './lib/platforms.js';

export async function rollback(pkgRoot) {
  const configPath = findConfig();
  if (!configPath) {
    console.error("Error: No Robin workspace found. Run 'robin init' to create one.");
    process.exit(1);
  }

  const workspaceDir = join(configPath, '..');
  const __migration = migrateConfigFilename(workspaceDir);
  if (__migration.migrated) {
    console.log('Migrated arc.config.json → robin.config.json');
  }
  const archiveDir = join(workspaceDir, 'archive');

  if (!existsSync(archiveDir)) {
    console.error('No backups found in archive/.');
    process.exit(1);
  }

  const backups = readdirSync(archiveDir).sort().reverse();

  if (backups.length === 0) {
    console.error('No backups found in archive/.');
    process.exit(1);
  }

  const latestBackup = backups[0];
  const backupPath = join(archiveDir, latestBackup);

  if (latestBackup.startsWith('pre-v2-')) {
    console.log(`Rolling back to pre-v2 backup: ${latestBackup}`);
    console.log('This is a full workspace restore.');

    const entries = readdirSync(backupPath);
    for (const entry of entries) {
      const dest = join(workspaceDir, entry);
      if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
      cpSync(join(backupPath, entry), dest, { recursive: true });
    }

    console.log('Full rollback complete.');
    return;
  }

  console.log(`Rolling back to: ${latestBackup}`);

  for (const file of SYSTEM_FILES) {
    const src = join(backupPath, file);
    if (existsSync(src)) {
      cpSync(src, join(workspaceDir, file));
    }
  }

  const backupProtocols = join(backupPath, 'protocols');
  if (existsSync(backupProtocols)) {
    rmSync(join(workspaceDir, 'protocols'), { recursive: true, force: true });
    cpSync(backupProtocols, join(workspaceDir, 'protocols'), { recursive: true });
  }

  console.log('Rollback complete.');
}
