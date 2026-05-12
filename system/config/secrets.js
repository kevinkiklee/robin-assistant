import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { paths } from './data-store.js';

function envPath() {
  return join(paths.data.secrets(), '.env');
}

function parseEnv(path) {
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

export function requireSecret(key) {
  const value = parseEnv(envPath()).get(key);
  if (!value)
    throw new Error(
      `missing secret: ${key}. Set it in ${envPath()} or run: robin secrets import --from <v1-user-data>`,
    );
  return value;
}

export function getSecret(key) {
  return parseEnv(envPath()).get(key) ?? null;
}

export function listKeys() {
  return [...parseEnv(envPath()).keys()];
}

export function envFilePath() {
  return envPath();
}

// Keys must be POSIX shell-style identifiers so they parse identically in
// dotenv readers, login shells, and downstream tooling. This also blocks
// injection where a corrupted key smuggles in `\n` or `=` characters.
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function assertValidSecret(key, value) {
  if (typeof key !== 'string' || !ENV_KEY_RE.test(key)) {
    throw new Error(`invalid secret key: must match ${ENV_KEY_RE} (got: ${JSON.stringify(key)})`);
  }
  if (typeof value !== 'string') {
    throw new Error(`invalid secret value for ${key}: must be a string`);
  }
  // Newlines in a value would split the line in the .env file, silently
  // inserting whatever follows as an extra KEY=VAL pair. Reject explicitly
  // rather than corrupting the store.
  if (/[\r\n]/.test(value)) {
    throw new Error(`invalid secret value for ${key}: must not contain newline characters`);
  }
}

export function saveSecret(key, value) {
  assertValidSecret(key, value);
  const path = envPath();
  mkdirSync(dirname(path), { recursive: true });
  let lines = [];
  if (existsSync(path)) {
    lines = readFileSync(path, 'utf-8').split('\n');
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  }
  let replaced = false;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
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
  const content = `${lines.join('\n')}\n`;
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, content, { mode: 0o600 });
  renameSync(tmp, path);
  chmodSync(path, 0o600);
}

export function importFrom(srcPath, { force = false } = {}) {
  const dest = envPath();
  if (existsSync(dest) && !force) {
    throw new Error(`destination ${dest} already exists; rerun with --force to overwrite`);
  }
  if (!existsSync(srcPath)) {
    throw new Error(`source not found: ${srcPath}`);
  }
  const src = readFileSync(srcPath, 'utf-8');
  mkdirSync(dirname(dest), { recursive: true });
  const tmp = `${dest}.tmp`;
  writeFileSync(tmp, src, { mode: 0o600 });
  renameSync(tmp, dest);
  chmodSync(dest, 0o600);
}
