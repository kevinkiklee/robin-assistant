import { existsSync } from 'fs';
import { join, resolve } from 'path';

export function findConfig(startDir) {
  let dir = resolve(startDir || '.');
  while (dir !== '/') {
    // Accept the new name first, then the legacy name
    if (existsSync(join(dir, 'robin.config.json'))) return join(dir, 'robin.config.json');
    if (existsSync(join(dir, 'arc.config.json'))) return join(dir, 'arc.config.json');
    dir = join(dir, '..');
  }
  return null;
}

export function findWorkspace(startDir) {
  const configPath = findConfig(startDir);
  if (!configPath) return null;
  return join(configPath, '..');
}
