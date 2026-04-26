import { existsSync } from 'fs';
import { join, resolve } from 'path';

export function findConfig(startDir) {
  let dir = resolve(startDir || '.');
  while (dir !== '/') {
    const candidate = join(dir, 'arc.config.json');
    if (existsSync(candidate)) return candidate;
    dir = join(dir, '..');
  }
  return null;
}

export function findWorkspace(startDir) {
  const configPath = findConfig(startDir);
  if (!configPath) return null;
  return join(configPath, '..');
}
