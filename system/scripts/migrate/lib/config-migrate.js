import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

function resolveConfigPath(workspaceDir) {
  // Prefer the post-0021 location, fall back to the pre-0021 location.
  const newP = join(workspaceDir, 'user-data/ops/config/robin.config.json');
  if (existsSync(newP)) return newP;
  const oldP = join(workspaceDir, 'user-data/robin.config.json');
  if (existsSync(oldP)) return oldP;
  return newP;
}

export async function migrateConfig(workspaceDir = process.cwd()) {
  const userPath = resolveConfigPath(workspaceDir);
  const skelPath = join(workspaceDir, 'system/scaffold/robin.config.json');
  if (!existsSync(userPath) || !existsSync(skelPath)) return { added: [], removed: [] };

  const user = JSON.parse(readFileSync(userPath, 'utf-8'));
  const skel = JSON.parse(readFileSync(skelPath, 'utf-8'));

  const added = [];
  const removed = [];

  // Add missing top-level keys (deep clone of scaffold value)
  for (const key of Object.keys(skel)) {
    if (!(key in user)) {
      user[key] = JSON.parse(JSON.stringify(skel[key]));
      added.push(key);
    }
  }
  // Mark fields that exist in user but not scaffold
  for (const key of Object.keys(user)) {
    if (!(key in skel)) removed.push(key);
  }

  if (added.length > 0) writeFileSync(userPath, JSON.stringify(user, null, 2) + '\n');
  return { added, removed };
}
