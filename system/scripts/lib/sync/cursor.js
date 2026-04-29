import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';

export function cursorPath(workspaceDir, name) {
  return join(workspaceDir, `user-data/state/sync/${name}.json`);
}

export function loadCursor(workspaceDir, name) {
  const path = cursorPath(workspaceDir, name);
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, 'utf-8'));
}

export function saveCursor(workspaceDir, name, partial) {
  const path = cursorPath(workspaceDir, name);
  mkdirSync(dirname(path), { recursive: true });
  const existing = existsSync(path) ? JSON.parse(readFileSync(path, 'utf-8')) : {};
  const merged = { ...existing, ...partial };
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(merged, null, 2) + '\n');
  renameSync(tmp, path);
}
