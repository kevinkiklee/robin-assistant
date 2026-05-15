// Append-only divergence log for stage-2 parallel-run validation.
//
// Used by `robin doctor --diff-legacy` to record when the framework's
// invariant output disagrees with the legacy probe. JSON-lines format.
//
// Rotation: when the file exceeds ROTATE_BYTES, the existing file is
// renamed to <path>.<iso8601>.old and a fresh file is opened. Files
// older than RETAIN_DAYS are pruned on each append.

import { appendFileSync, existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

const ROTATE_BYTES = 1 * 1024 * 1024; // 1 MB
const RETAIN_DAYS = 30;
const RETAIN_MS = RETAIN_DAYS * 24 * 60 * 60 * 1000;

function rotateIfNeeded(path) {
  if (!existsSync(path)) return;
  let size = 0;
  try {
    size = statSync(path).size;
  } catch {
    return;
  }
  if (size < ROTATE_BYTES) return;
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  try {
    renameSync(path, `${path}.${ts}.old`);
  } catch {
    // best-effort
  }
}

function pruneOld(path) {
  const dir = dirname(path);
  const prefix = basename(path);
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  const cutoff = Date.now() - RETAIN_MS;
  for (const name of entries) {
    if (!name.startsWith(`${prefix}.`) || !name.endsWith('.old')) continue;
    const full = join(dir, name);
    try {
      if (statSync(full).mtimeMs < cutoff) unlinkSync(full);
    } catch {
      // best-effort
    }
  }
}

export function recordDivergence(path, entry) {
  mkdirSync(dirname(path), { recursive: true });
  rotateIfNeeded(path);
  pruneOld(path);
  const payload = JSON.stringify({ ts: new Date().toISOString(), ...entry });
  appendFileSync(path, `${payload}\n`, { mode: 0o644 });
}
