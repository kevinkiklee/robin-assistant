import { readFileSync, writeFileSync, existsSync, cpSync, rmSync, readdirSync, chmodSync } from 'fs';
import { join, resolve } from 'path';
import { generateClaudeMd } from './generate-claude-md.js';

export async function rollback(pkgRoot) {
  const configPath = findConfig();
  if (!configPath) {
    console.error('Error: arc.config.json not found. Are you in an Arc workspace?');
    process.exit(1);
  }

  const workspaceDir = join(configPath, '..');
  const archiveDir = join(workspaceDir, 'archive');

  if (!existsSync(archiveDir)) {
    console.error('No backups found in archive/.');
    process.exit(1);
  }

  const backups = readdirSync(archiveDir)
    .filter(d => d.startsWith('core-'))
    .sort()
    .reverse();

  if (backups.length === 0) {
    console.error('No core backups found in archive/.');
    process.exit(1);
  }

  const latestBackup = backups[0];
  const backupPath = join(archiveDir, latestBackup);

  console.log(`Rolling back to: ${latestBackup}`);

  const currentCore = join(workspaceDir, 'core');
  rmSync(currentCore, { recursive: true, force: true });
  cpSync(backupPath, currentCore, { recursive: true });

  // Make coordination scripts executable after restore
  const coordDir = join(currentCore, 'coordination');
  for (const script of ['lock.sh', 'register-session.sh']) {
    const scriptPath = join(coordDir, script);
    if (existsSync(scriptPath)) {
      chmodSync(scriptPath, 0o755);
    }
  }

  // Read version from restored core
  const versionJsonPath = join(currentCore, 'version.json');
  if (existsSync(versionJsonPath)) {
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    const versionJson = JSON.parse(readFileSync(versionJsonPath, 'utf-8'));
    config.version = versionJson.version;
    writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
  }

  generateClaudeMd(workspaceDir, pkgRoot);

  console.log('Rollback complete. CLAUDE.md regenerated.');
}

function findConfig() {
  let dir = resolve('.');
  while (dir !== '/') {
    const candidate = join(dir, 'arc.config.json');
    if (existsSync(candidate)) return candidate;
    dir = join(dir, '..');
  }
  return null;
}
