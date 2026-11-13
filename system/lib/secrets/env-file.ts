import {
  chmodSync,
  copyFileSync,
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { LINE, unquote } from './load-env.ts';

const KEEP_BACKUPS = 5;

/** Parse env-file text with the same grammar as `loadEnvFile`. */
export function parseEnvFile(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const m = LINE.exec(line);
    if (m) out.set(m[1], unquote(m[2]));
  }
  return out;
}

/** Read an env file; an empty map when it does not exist. */
export function readEnvFile(path: string): Map<string, string> {
  return existsSync(path) ? parseEnvFile(readFileSync(path, 'utf8')) : new Map();
}

function stamp(d: Date): string {
  return d
    .toISOString()
    .replace(/\.\d+Z$/, '')
    .replace(/[-:]/g, '');
}

function backup(path: string, now: Date): void {
  copyFileSync(path, `${path}.bak-${stamp(now)}`);
  chmodSync(`${path}.bak-${stamp(now)}`, 0o600);
  const prefix = `${basename(path)}.bak-`;
  const baks = readdirSync(dirname(path))
    .filter((f) => f.startsWith(prefix))
    .sort();
  for (const old of baks.slice(0, Math.max(0, baks.length - KEEP_BACKUPS))) {
    rmSync(join(dirname(path), old), { force: true });
  }
}

function atomicWrite(path: string, content: string, backups: boolean, now: Date): void {
  if (backups && existsSync(path)) backup(path, now);
  const tmp = `${path}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, content, { encoding: 'utf8', mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

/**
 * The value as it goes after `KEY=`, read back unchanged by `parseEnvFile`.
 * Double-quoted when it holds whitespace, `=`, `"`, `'`, `#` or a backslash
 * (and so any leading/trailing space); inside the quotes backslash and `"` are
 * escaped.
 * Throws on `\n` / `\r`: the grammar is one line per key.
 */
function envLiteral(value: string): string {
  if (/[\r\n]/.test(value)) throw new Error('refused: env values cannot contain a newline');
  if (!/[\s="'#\\]/.test(value)) return value;
  return `"${value.replace(/[\\"]/g, (c) => `\\${c}`)}"`;
}

/**
 * Replace (or append) a `KEY=value` line, preserving every other line (see
 * `envLiteral` for quoting). Written to a 0600 temp file then renamed; an
 * existing file is first copied to `<path>.bak-<YYYYMMDDTHHMMSS>` (0600),
 * keeping the newest 5.
 */
export function writeEnvKey(
  path: string,
  key: string,
  value: string,
  opts: { backups?: boolean; now?: Date } = {},
): void {
  const literal = envLiteral(value);
  const original = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const line = `${key}=${literal}`;
  const re = new RegExp(`^(?:export\\s+)?${key}=.*$`, 'm');
  const next = re.test(original)
    ? original.replace(re, () => line)
    : original.trim() === ''
      ? `${line}\n`
      : `${original.trimEnd()}\n${line}\n`;
  atomicWrite(path, next, opts.backups !== false, opts.now ?? new Date());
}

/** Remove a key's line. Returns whether it was present. */
export function removeEnvKey(
  path: string,
  key: string,
  opts: { backups?: boolean; now?: Date } = {},
): boolean {
  if (!existsSync(path)) return false;
  const original = readFileSync(path, 'utf8');
  const re = new RegExp(`^(?:export\\s+)?${key}=.*(?:\\r?\\n|$)`, 'm');
  if (!re.test(original)) return false;
  atomicWrite(path, original.replace(re, ''), opts.backups !== false, opts.now ?? new Date());
  return true;
}

/** Write a whole-file secret (`value\n`) with the same tmp/rename/0600/backup rules. */
export function writeSecretFile(path: string, value: string, opts: { now?: Date } = {}): void {
  atomicWrite(path, `${value}\n`, true, opts.now ?? new Date());
}
