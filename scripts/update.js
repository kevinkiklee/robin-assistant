import { readFileSync, writeFileSync, existsSync, cpSync, rmSync, mkdirSync, chmodSync } from 'fs';
import { join, resolve } from 'path';
import { generateClaudeMd } from './generate-claude-md.js';
import { migrate } from './migrate.js';

export async function update(pkgRoot) {
  const configPath = findConfig();
  if (!configPath) {
    console.error('Error: arc.config.json not found. Are you in an Arc workspace?');
    process.exit(1);
  }

  const workspaceDir = join(configPath, '..');
  const config = JSON.parse(readFileSync(configPath, 'utf-8'));
  const oldVersion = config.version;

  const newVersionJson = JSON.parse(
    readFileSync(join(pkgRoot, 'core', 'version.json'), 'utf-8')
  );
  const newVersion = newVersionJson.version;

  if (oldVersion === newVersion) {
    console.log(`Already on version ${newVersion}.`);
    return;
  }

  console.log(`Updating ${oldVersion} → ${newVersion}...`);

  // Backup current core/
  const backupDir = join(workspaceDir, 'archive', `core-${oldVersion}-${formatDate()}`);
  const currentCore = join(workspaceDir, 'core');
  if (existsSync(currentCore)) {
    mkdirSync(backupDir, { recursive: true });
    cpSync(currentCore, backupDir, { recursive: true });
  }

  // Replace core/ atomically
  rmSync(currentCore, { recursive: true, force: true });
  cpSync(join(pkgRoot, 'core'), currentCore, { recursive: true });

  // Make coordination scripts executable
  const coordDir = join(currentCore, 'coordination');
  for (const script of ['lock.sh', 'register-session.sh']) {
    const scriptPath = join(coordDir, script);
    if (existsSync(scriptPath)) {
      chmodSync(scriptPath, 0o755);
    }
  }

  // Run migrations
  await migrate(workspaceDir, pkgRoot, oldVersion, newVersion);

  // Regenerate CLAUDE.md
  generateClaudeMd(workspaceDir, pkgRoot);

  // Update version in config
  config.version = newVersion;
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');

  console.log(`Updated to ${newVersion}. Previous core backed up to archive/.`);
}

function formatDate() {
  return new Date().toISOString().slice(0, 10);
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
