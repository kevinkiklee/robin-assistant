import { existsSync } from 'fs';
import { join, resolve } from 'path';
import { execSync } from 'child_process';

export async function exportData() {
  const configPath = findConfig();
  if (!configPath) {
    console.error('Error: arc.config.json not found. Are you in an Arc workspace?');
    process.exit(1);
  }

  const workspaceDir = join(configPath, '..');
  const timestamp = new Date().toISOString().slice(0, 10);
  const archiveName = `arc-export-${timestamp}.tar.gz`;
  const archivePath = join(workspaceDir, archiveName);

  const dirs = [
    'profile', 'memory', 'todos', 'knowledge', 'decisions',
    'journal', 'inbox', 'skills', 'self-improvement', 'overrides',
    'artifacts', 'arc.config.json'
  ].filter(d => existsSync(join(workspaceDir, d)));

  execSync(
    `tar -czf "${archiveName}" ${dirs.join(' ')}`,
    { cwd: workspaceDir }
  );

  console.log(`Exported to: ${archivePath}`);
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
