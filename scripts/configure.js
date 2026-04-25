import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, resolve } from 'path';
import { generateClaudeMd } from './generate-claude-md.js';

export async function configure(options, pkgRoot) {
  const configPath = findConfig();
  if (!configPath) {
    console.error('Error: arc.config.json not found. Are you in an Arc workspace?');
    process.exit(1);
  }

  const workspaceDir = join(configPath, '..');
  const config = JSON.parse(readFileSync(configPath, 'utf-8'));

  let changed = false;

  if (options.name) {
    config.user.name = options.name;
    changed = true;
  }
  if (options.timezone) {
    config.user.timezone = options.timezone;
    changed = true;
  }
  if (options.email) {
    config.user.email = options.email;
    changed = true;
  }
  if (options.assistantName) {
    config.assistant.name = options.assistantName;
    changed = true;
  }

  // Mark as initialized if name and timezone are set
  if (config.user.name && config.user.timezone) {
    config.initialized = true;
  }

  if (!changed) {
    console.log('Current configuration:');
    console.log(JSON.stringify(config, null, 2));
    return;
  }

  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
  generateClaudeMd(workspaceDir, pkgRoot);
  console.log('Configuration updated. CLAUDE.md regenerated.');
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
