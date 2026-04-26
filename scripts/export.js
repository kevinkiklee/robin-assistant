import { existsSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import { findConfig } from './lib/find-config.js';
import { USER_DATA_FILES } from './lib/platforms.js';

export async function exportData() {
  const configPath = findConfig();
  if (!configPath) {
    console.error('Error: arc.config.json not found. Are you in a Robin workspace?');
    process.exit(1);
  }

  const workspaceDir = join(configPath, '..');
  const timestamp = new Date().toISOString().slice(0, 10);
  const archiveName = `arc-export-${timestamp}.tar.gz`;

  const targets = [
    ...USER_DATA_FILES,
    'arc.config.json',
    'artifacts',
    'state',
  ].filter(d => existsSync(join(workspaceDir, d)));

  execSync(
    `tar -czf "${archiveName}" ${targets.join(' ')}`,
    { cwd: workspaceDir }
  );

  console.log(`Exported to: ${join(workspaceDir, archiveName)}`);
}
