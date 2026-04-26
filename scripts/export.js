import { existsSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import { findConfig } from './lib/find-config.js';
import { migrateConfigFilename } from './lib/migrate-config-filename.js';
import { USER_DATA_FILES } from './lib/platforms.js';

export async function exportData() {
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
  const timestamp = new Date().toISOString().slice(0, 10);
  const archiveName = `robin-export-${timestamp}.tar.gz`;

  const targets = [
    ...USER_DATA_FILES,
    'robin.config.json',
    'artifacts',
    'state',
  ].filter(d => existsSync(join(workspaceDir, d)));

  execSync(
    `tar -czf "${archiveName}" ${targets.join(' ')}`,
    { cwd: workspaceDir }
  );

  console.log(`Exported to: ${join(workspaceDir, archiveName)}`);
}
