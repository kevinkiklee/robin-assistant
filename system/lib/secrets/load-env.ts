import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface LoadEnvResult {
  path: string;
  loaded: number;
  overwritten: number;
}

const LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/;

function unquote(raw: string): string {
  if (raw.length >= 2) {
    const first = raw[0];
    const last = raw[raw.length - 1];
    if ((first === '"' || first === "'") && first === last) {
      const inner = raw.slice(1, -1);
      // Only honor escape sequences inside double quotes (POSIX shell convention)
      return first === '"' ? inner.replace(/\\([nrt"\\$])/g, (_, c) => unescapeEnvChar(c)) : inner;
    }
  }
  return raw;
}

function unescapeEnvChar(ch: string): string {
  switch (ch) {
    case 'n':
      return '\n';
    case 'r':
      return '\r';
    case 't':
      return '\t';
    default:
      return ch;
  }
}

/**
 * Read `<userDataDir>/config/secrets/.env` and populate `process.env` for any
 * key not already set. The on-disk file wins over nothing; the shell wins over
 * the file. Returns `{ loaded: 0 }` when the file is absent — callers should
 * treat that as fine (secrets may come from launchd, the shell, or 1Password).
 *
 * Format: standard KEY=VALUE lines, `#` comments, optional `export `, optional
 * matched single- or double-quote wrapping. Multiline values are not supported.
 */
export function loadEnvFile(
  userDataDir: string,
  env: NodeJS.ProcessEnv = process.env,
): LoadEnvResult {
  const path = join(userDataDir, 'config', 'secrets', '.env');
  if (!existsSync(path)) return { path, loaded: 0, overwritten: 0 };

  const text = readFileSync(path, 'utf8');
  let loaded = 0;
  let overwritten = 0;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const m = LINE.exec(line);
    if (!m) continue;
    const key = m[1];
    const value = unquote(m[2]);
    if (env[key] !== undefined) {
      overwritten++;
      continue;
    }
    env[key] = value;
    loaded++;
  }
  return { path, loaded, overwritten };
}
