import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';

export function cursorPath(workspaceDir, name) {
  return join(workspaceDir, `user-data/runtime/state/sync/${name}.json`);
}

// Read state JSON. On corruption (truncated/invalid JSON from a prior crash),
// quarantine the file with a timestamp suffix and return {} so callers get a
// fresh start instead of permanent sync failure.
function readStateJson(path) {
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, 'utf-8');
  try {
    return JSON.parse(raw);
  } catch (err) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const quarantine = `${path}.corrupt-${stamp}`;
    try {
      renameSync(path, quarantine);
      console.warn(`[cursor] corrupt state at ${path} (${err.message}); quarantined to ${quarantine}`);
    } catch {
      // ignore — fall through with {}
    }
    return {};
  }
}

export function loadCursor(workspaceDir, name) {
  return readStateJson(cursorPath(workspaceDir, name));
}

// saveCursor performs a SHALLOW merge with the existing state — top-level keys
// from `partial` overwrite the prior file's keys. Nested objects (e.g. the
// `cursor` field) are replaced entirely, not merged. Pass the full nested
// object you want stored.
export function saveCursor(workspaceDir, name, partial) {
  const path = cursorPath(workspaceDir, name);
  mkdirSync(dirname(path), { recursive: true });
  const existing = readStateJson(path);
  const merged = { ...existing, ...partial };
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(merged, null, 2) + '\n');
  renameSync(tmp, path);
}
