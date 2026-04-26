import { readFileSync, writeFileSync, existsSync, cpSync, rmSync, mkdirSync } from 'fs';
import { join } from 'path';
import { findConfig } from './lib/find-config.js';
import { migrateConfigFilename } from './lib/migrate-config-filename.js';
import { SYSTEM_FILES } from './lib/platforms.js';
import { migrate } from './migrate.js';

export async function update(pkgRoot) {
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
  const newConfigPath = join(workspaceDir, 'robin.config.json');
  const config = JSON.parse(readFileSync(newConfigPath, 'utf-8'));
  const oldVersion = config.version;

  const pkgJson = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf-8'));
  const newVersion = pkgJson.version;

  if (oldVersion === newVersion) {
    console.log(`Already on version ${newVersion}.`);
    return;
  }

  console.log(`Updating ${oldVersion} -> ${newVersion}...`);

  const backupDir = join(workspaceDir, 'archive', `system-${oldVersion}-${formatDate()}`);
  mkdirSync(backupDir, { recursive: true });

  for (const file of SYSTEM_FILES) {
    const src = join(workspaceDir, file);
    if (existsSync(src)) {
      cpSync(src, join(backupDir, file));
    }
  }

  const protocolsSrc = join(workspaceDir, 'protocols');
  if (existsSync(protocolsSrc)) {
    cpSync(protocolsSrc, join(backupDir, 'protocols'), { recursive: true });
  }

  const coreDir = join(pkgRoot, 'core');
  for (const file of SYSTEM_FILES) {
    const src = join(coreDir, file);
    if (existsSync(src)) {
      cpSync(src, join(workspaceDir, file));
    }
  }

  const newProtocols = join(coreDir, 'protocols');
  if (existsSync(newProtocols)) {
    rmSync(join(workspaceDir, 'protocols'), { recursive: true, force: true });
    cpSync(newProtocols, join(workspaceDir, 'protocols'), { recursive: true });
  }

  await migrate(workspaceDir, pkgRoot, oldVersion, newVersion);

  config.version = newVersion;
  writeFileSync(newConfigPath, JSON.stringify(config, null, 2) + '\n');

  console.log(`Updated to ${newVersion}. Previous system files backed up to archive/.`);
}

function formatDate() {
  return new Date().toISOString().slice(0, 10);
}
