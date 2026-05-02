import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';

// Cycle-2a: secrets are NOT loaded into process.env at startup. Each consumer
// calls requireSecret(workspaceDir, key) to read the value lazily from
// user-data/secrets/.env on demand. This prevents subprocess inheritance of
// secrets via env (the discord-bot's claude -p children, for example, no
// longer see GITHUB_PAT or DISCORD_BOT_TOKEN in their process.env).

function envPath(workspaceDir) {
  return join(workspaceDir, 'user-data/secrets/.env');
}

function parseEnv(workspaceDir) {
  const path = envPath(workspaceDir);
  const out = new Map();
  if (!existsSync(path)) return out;
  const content = readFileSync(path, 'utf-8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    out.set(trimmed.slice(0, eq).trim(), trimmed.slice(eq + 1).trim());
  }
  return out;
}

// Read a single secret from user-data/secrets/.env. Throws if missing.
// Does NOT pollute process.env. Per-call I/O cost is ~1ms on SSD —
// secrets are read 2-3 times per session in practice; caching would
// defeat the "secrets don't linger in module memory" property.
export function requireSecret(workspaceDir, key) {
  if (!workspaceDir || !key) {
    throw new TypeError('requireSecret: workspaceDir and key are required');
  }
  const value = parseEnv(workspaceDir).get(key);
  if (!value) {
    throw new Error(
      `Missing secret: ${key}. Add it to user-data/secrets/.env (see system/scaffold/secrets/README.md).`
    );
  }
  return value;
}

// Optional helper: returns null instead of throwing.
export function getSecret(workspaceDir, key) {
  if (!workspaceDir || !key) {
    throw new TypeError('getSecret: workspaceDir and key are required');
  }
  return parseEnv(workspaceDir).get(key) ?? null;
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
  writeFileSync(tmp, content, { mode: 0o600 });
  renameSync(tmp, path);
  chmodSync(path, 0o600);
  // Note: cycle-2a removes the process.env propagation that the previous
  // saveSecret had. New value is on disk; in-process consumers re-read on
  // their next requireSecret call.
}

// Backwards-compat shim: loadSecrets is a no-op now. Existing callers can
// be updated lazily; they'll read via requireSecret(workspaceDir, key) after
// migration. Throws if anyone calls without workspaceDir to surface stale
// callers loudly.
export function loadSecrets(workspaceDir) {
  if (!workspaceDir) {
    throw new TypeError('loadSecrets: workspaceDir is required (and the function is now a no-op; migrate callers to requireSecret(workspaceDir, key))');
  }
  // Intentional no-op. process.env is no longer the source of truth for secrets.
}
