import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'fs';
import { join, resolve } from 'path';
import { findConfig } from './lib/find-config.js';
import { migrateConfigFilename } from './lib/migrate-config-filename.js';
import { PLATFORMS, generateIntegrationsMd } from './lib/platforms.js';

export async function configure(options, pkgRoot) {
  const configPath = findConfig();
  if (!configPath) {
    console.error('Error: arc.config.json not found. Are you in a Robin workspace?');
    process.exit(1);
  }
  const workspaceDir = join(configPath, '..');
  const __migration = migrateConfigFilename(workspaceDir);
  if (__migration.migrated) {
    console.log('Migrated arc.config.json → robin.config.json');
  }
  await configureInDir(workspaceDir, options);
}

export async function configureInDir(workspaceDir, options) {
  const configPath = join(workspaceDir, 'robin.config.json');
  const config = JSON.parse(readFileSync(configPath, 'utf-8'));
  let changed = false;

  if (options.name) { config.user.name = options.name; changed = true; }
  if (options.timezone) { config.user.timezone = options.timezone; changed = true; }
  if (options.email) { config.user.email = options.email; changed = true; }
  if (options.assistantName) { config.assistant.name = options.assistantName; changed = true; }

  if (options.platform && options.platform !== config.platform) {
    const oldPlatform = PLATFORMS[config.platform];
    if (oldPlatform?.pointerFile) {
      const oldPath = join(workspaceDir, oldPlatform.pointerFile);
      if (existsSync(oldPath)) unlinkSync(oldPath);
    }

    const newPlatform = PLATFORMS[options.platform];
    if (newPlatform?.pointerFile) {
      writeFileSync(join(workspaceDir, newPlatform.pointerFile), newPlatform.pointerContent);
    }

    config.platform = options.platform;
    changed = true;

    const intMd = generateIntegrationsMd(config.platform, config.integrations || []);
    writeFileSync(join(workspaceDir, 'integrations.md'), intMd);
  }

  if (options.addIntegration) {
    if (!config.integrations) config.integrations = [];
    if (!config.integrations.includes(options.addIntegration)) {
      config.integrations.push(options.addIntegration);
      changed = true;
    }
    const intMd = generateIntegrationsMd(config.platform, config.integrations);
    writeFileSync(join(workspaceDir, 'integrations.md'), intMd);
  }

  if (options.removeIntegration) {
    if (config.integrations) {
      config.integrations = config.integrations.filter(i => i !== options.removeIntegration);
      changed = true;
    }
    const intMd = generateIntegrationsMd(config.platform, config.integrations || []);
    writeFileSync(join(workspaceDir, 'integrations.md'), intMd);
  }

  if (config.user.name && config.user.timezone) config.initialized = true;

  if (!changed) {
    console.log('Current configuration:');
    console.log(JSON.stringify(config, null, 2));
    return;
  }

  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
  console.log('Configuration updated.');
}
