import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export function loadSecrets(workspaceDir = process.cwd()) {
  const path = join(workspaceDir, 'user-data/secrets/.env');
  if (!existsSync(path)) return;
  const content = readFileSync(path, 'utf-8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (!(key in process.env)) process.env[key] = value;
  }
}

export function requireSecret(key) {
  const value = process.env[key];
  if (!value) {
    throw new Error(
      `Missing secret: ${key}. Add it to user-data/secrets/.env (see .env.example).`
    );
  }
  return value;
}
