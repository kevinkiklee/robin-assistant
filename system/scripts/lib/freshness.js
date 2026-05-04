// Freshness helpers for synced data files.
//
// Every file written by a sync job (sync-whoop, sync-nhl, sync-gmail, etc.)
// should carry `last_synced: <ISO 8601>` in its frontmatter so the model can
// mechanically check whether quoted fields are current before stating them as
// "today's" or "latest" data. This module centralizes that contract.
//
// Exports:
//   stampLastSynced(filePath, [ts]) — atomic write that updates (or inserts)
//     the `last_synced` frontmatter field. Used by sync writers after a
//     successful refresh. tmp + rename so partial writes never corrupt the
//     frontmatter.
//   isFresh(filePath, [maxAgeHours]) — true when last_synced is within the
//     window. Returns null when the field is missing or unparseable so the
//     caller can label freshness as "unknown."
//   getLastSynced(filePath) — ISO string from the frontmatter, or null.
//
// Frontmatter parsing is intentionally simple (key: value lines between
// `---` fences) — we don't depend on a YAML library. Files without
// frontmatter get one inserted on stamp.

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const FM_RE = /^---\n([\s\S]*?)\n---\n?/;

function parseFrontmatter(text) {
  const m = text.match(FM_RE);
  if (!m) return { fm: null, rest: text, raw: '' };
  const fm = {};
  const order = [];
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([\w-]+):\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1].trim();
    if (!(key in fm)) order.push(key);
    fm[key] = kv[2].trim();
  }
  return { fm, order, rest: text.slice(m[0].length), raw: m[0] };
}

function serializeFrontmatter(fm, order) {
  const seen = new Set();
  const lines = [];
  for (const k of order) {
    if (seen.has(k)) continue;
    seen.add(k);
    lines.push(`${k}: ${fm[k]}`);
  }
  for (const k of Object.keys(fm)) {
    if (seen.has(k)) continue;
    seen.add(k);
    lines.push(`${k}: ${fm[k]}`);
  }
  return `---\n${lines.join('\n')}\n---\n`;
}

function atomicWrite(path, content) {
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

// Update (or insert) the `last_synced` field in `filePath`'s frontmatter.
// `ts` defaults to the current ISO timestamp. Idempotent at the field level —
// re-stamping with the same ts is benign. Returns the timestamp written.
export function stampLastSynced(filePath, ts = new Date().toISOString()) {
  if (!existsSync(filePath)) {
    throw new Error(`stampLastSynced: file not found: ${filePath}`);
  }
  const text = readFileSync(filePath, 'utf8');
  const parsed = parseFrontmatter(text);
  let next;
  if (parsed.fm === null) {
    // No frontmatter — insert one with just last_synced.
    next = `---\nlast_synced: ${ts}\n---\n${text.startsWith('\n') ? '' : '\n'}${text}`;
  } else {
    parsed.fm.last_synced = ts;
    if (!parsed.order.includes('last_synced')) parsed.order.push('last_synced');
    next = serializeFrontmatter(parsed.fm, parsed.order) + parsed.rest;
  }
  atomicWrite(filePath, next);
  return ts;
}

// Returns the ISO string written under `last_synced` in the file's
// frontmatter, or null when the file is missing, has no frontmatter, or
// has no last_synced field.
export function getLastSynced(filePath) {
  if (!existsSync(filePath)) return null;
  let text;
  try { text = readFileSync(filePath, 'utf8'); } catch { return null; }
  const { fm } = parseFrontmatter(text);
  if (!fm || !fm.last_synced) return null;
  return fm.last_synced;
}

// True when last_synced is within `maxAgeHours` of now.
// Returns null when last_synced is missing or unparseable so callers can
// distinguish "stale" from "unknown freshness."
// A future timestamp (clock skew) yields true (negative age treated as fresh).
export function isFresh(filePath, maxAgeHours = 24) {
  const ts = getLastSynced(filePath);
  if (!ts) return null;
  const t = Date.parse(ts);
  if (Number.isNaN(t)) return null;
  const ageMs = Date.now() - t;
  if (ageMs < 0) return true; // future timestamp — treat as fresh
  return ageMs <= maxAgeHours * 3600 * 1000;
}
