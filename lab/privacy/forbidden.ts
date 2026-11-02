import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Shapes no simulated run may ever emit, whoever the operator is.
const FIXED: RegExp[] = [
  /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i, // any email address
  /\b(?:he|his|him)\b/i, // the sim user is unnamed and ungendered
];

/**
 * The operator's own forbidden terms (name, employer, places, gear, birthday)
 * live in `forbidden.local.txt` beside this file — gitignored, so the public
 * repo never lists them. One case-insensitive regex per line; `#` comments.
 * Absent (CI, a fresh clone) → only the generic shapes are checked.
 */
const LOCAL_FILE = join(dirname(fileURLToPath(import.meta.url)), 'forbidden.local.txt');

let local: RegExp[] | null = null;

export function localForbidden(): RegExp[] {
  if (local) return local;
  local = existsSync(LOCAL_FILE)
    ? readFileSync(LOCAL_FILE, 'utf8')
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#'))
        .map((l) => new RegExp(l, 'i'))
    : [];
  return local;
}

/** Forbidden strings found in `text` (empty = clean). */
export function scanText(text: string): string[] {
  const hits: string[] = [];
  for (const re of [...FIXED, ...localForbidden()]) {
    const m = re.exec(text);
    if (m) hits.push(m[0]);
  }
  return hits;
}
