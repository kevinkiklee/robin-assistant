import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';

function envPath(workspaceDir) {
  return join(workspaceDir, 'user-data/secrets/.env');
}

export function loadSecrets(workspaceDir = process.cwd()) {
  const path = envPath(workspaceDir);
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
      `Missing secret: ${key}. Add it to user-data/secrets/.env (see system/skeleton/secrets/README.md).`
    );
  }
  return value;
}

export function saveSecret(workspaceDir, key, value) {
  const path = envPath(workspaceDir);
  mkdirSync(dirname(path), { recursive: true });
  let lines = [];
  if (existsSync(path)) {
    lines = readFileSync(path, 'utf-8').split('\n');
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  }
  let replaced = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    if (trimmed.slice(0, eq).trim() === key) {
      lines[i] = `${key}=${value}`;
      replaced = true;
      break;
    }
  }
  if (!replaced) lines.push(`${key}=${value}`);
  const content = lines.join('\n') + '\n';
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
  process.env[key] = value;
}
