// Cycle-2c: pattern lifecycle TTL.
//
// Patterns auto-promote from 3+ corrections (per the self-improvement
// framework). Without TTL, promoted patterns persist forever even when
// they no longer fire — a "persistence multiplier" attack vector and a
// drift toward stale advice.
//
// Each pattern carries `last_fired: YYYY-MM-DD` + `fired_count: N`
// frontmatter (set by Dream's TTL pass from the pattern-firings log).
// Optional per-pattern `ttl_days: N` overrides the default 180-day window.
//
// Dream calls processPatternTTL(workspaceDir) during its TTL phase. It:
//   1. Reads user-data/ops/state/pattern-firings.log (one line per firing,
//      written by the model via Bash echo).
//   2. Updates each pattern's last_fired + fired_count.
//   3. Truncates the firings log on success.
//   4. Archives any pattern whose last_fired exceeds its ttl_days
//      (or the default) into patterns-archive.md.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const DEFAULT_TTL_DAYS = 180;

const FIRINGS_LOG_REL = 'user-data/ops/state/pattern-firings.log';
const PATTERNS_FILE_REL = 'user-data/memory/self-improvement/patterns.md';
const ARCHIVE_FILE_REL = 'user-data/memory/self-improvement/patterns-archive.md';

function logPath(workspaceDir) { return join(workspaceDir, FIRINGS_LOG_REL); }
function patternsPath(workspaceDir) { return join(workspaceDir, PATTERNS_FILE_REL); }
function archivePath(workspaceDir) { return join(workspaceDir, ARCHIVE_FILE_REL); }

// Parse the firings log: one TSV line per fire — `<timestamp>\t<name>`.
// Returns Map<name, { count, lastDate }> where lastDate is a YYYY-MM-DD
// string of the most recent firing.
export function readFirings(workspaceDir) {
  const p = logPath(workspaceDir);
  const out = new Map();
  if (!existsSync(p)) return out;
  const raw = readFileSync(p, 'utf-8');
  for (const line of raw.split('\n')) {
    if (!line) continue;
    const [ts, name] = line.split('\t');
    if (!name) continue;
    const date = (ts || '').slice(0, 10);
    const cur = out.get(name) ?? { count: 0, lastDate: '' };
    cur.count += 1;
    if (date > cur.lastDate) cur.lastDate = date;
    out.set(name, cur);
  }
  return out;
}

export function truncateFirings(workspaceDir) {
  const p = logPath(workspaceDir);
  if (existsSync(p)) writeFileSync(p, '');
}

// Patterns.md uses fenced YAML-frontmatter style per pattern:
//   ## <pattern-title>
//   ---
//   name: <name>
//   last_fired: 2026-04-30
//   fired_count: 7
//   ttl_days: 180
//   ---
//   <body>
// Implementation here is intentionally simple: parse top-level "## " blocks
// and within each, look for a leading frontmatter region. We don't try to
// support arbitrary YAML — only the four fields we set.

const FM_RE = /^---\n([\s\S]*?)\n---\n?/;

function parsePatterns(content) {
  if (typeof content !== 'string' || !content.includes('## ')) {
    return { preamble: content || '', patterns: [] };
  }
  const parts = content.split(/^## /m);
  const preamble = parts.shift() ?? '';
  const patterns = [];
  for (const block of parts) {
    const titleEnd = block.indexOf('\n');
    const title = titleEnd >= 0 ? block.slice(0, titleEnd) : block;
    const rest = titleEnd >= 0 ? block.slice(titleEnd + 1) : '';
    const m = rest.match(FM_RE);
    const fields = {};
    let body = rest;
    if (m) {
      for (const line of m[1].split('\n')) {
        const idx = line.indexOf(':');
        if (idx === -1) continue;
        fields[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
      }
      body = rest.slice(m[0].length);
    }
    patterns.push({ title: title.trim(), fields, body });
  }
  return { preamble, patterns };
}

function serializePatterns({ preamble, patterns }) {
  let out = preamble || '';
  if (out && !out.endsWith('\n')) out += '\n';
  for (const p of patterns) {
    const fmLines = [];
    for (const [k, v] of Object.entries(p.fields)) {
      fmLines.push(`${k}: ${v}`);
    }
    out += `## ${p.title}\n`;
    if (fmLines.length) out += `---\n${fmLines.join('\n')}\n---\n`;
    out += p.body || '';
    if (!out.endsWith('\n')) out += '\n';
  }
  return out;
}

function daysBetween(aISO, bISO) {
  if (!aISO || !bISO) return Infinity;
  const a = Date.parse(aISO + 'T00:00:00Z');
  const b = Date.parse(bISO + 'T00:00:00Z');
  if (Number.isNaN(a) || Number.isNaN(b)) return Infinity;
  return Math.floor((b - a) / (24 * 60 * 60 * 1000));
}

// Orchestrator: applies firings → updates frontmatter → truncates log →
// archives expired patterns. Returns summary for journal.
export function processPatternTTL(workspaceDir, { now = new Date().toISOString().slice(0, 10), defaultTtlDays = DEFAULT_TTL_DAYS } = {}) {
  const summary = { updated: 0, archived: 0, fired_count_total: 0 };

  if (!existsSync(patternsPath(workspaceDir))) return summary;
  const patternsContent = readFileSync(patternsPath(workspaceDir), 'utf-8');
  const parsed = parsePatterns(patternsContent);
  if (parsed.patterns.length === 0) return summary;

  const firings = readFirings(workspaceDir);

  // Update last_fired + fired_count from log.
  for (const p of parsed.patterns) {
    const name = p.fields.name || p.title;
    const fire = firings.get(name);
    if (!fire) continue;
    summary.fired_count_total += fire.count;
    if (fire.lastDate && (!p.fields.last_fired || fire.lastDate > p.fields.last_fired)) {
      p.fields.last_fired = fire.lastDate;
    }
    p.fields.fired_count = String((Number(p.fields.fired_count) || 0) + fire.count);
    summary.updated += 1;
  }

  // Archive patterns past TTL.
  const archiveContent = existsSync(archivePath(workspaceDir))
    ? readFileSync(archivePath(workspaceDir), 'utf-8')
    : '---\ndescription: Archived patterns (TTL exceeded). Restore by moving back to patterns.md.\ntype: archive\n---\n\n';
  const archived = [];
  const remaining = [];
  for (const p of parsed.patterns) {
    const ttlDays = Number(p.fields.ttl_days) || defaultTtlDays;
    const lastFired = p.fields.last_fired || p.fields.created || '';
    const days = daysBetween(lastFired, now);
    if (days > ttlDays) {
      p.fields.archived_at = now;
      p.fields.archived_reason = `TTL exceeded (last fired ${lastFired || 'never'})`;
      archived.push(p);
    } else {
      remaining.push(p);
    }
  }

  if (archived.length > 0) {
    summary.archived = archived.length;
    const archiveAddition = serializePatterns({ preamble: '', patterns: archived });
    writeFileSync(archivePath(workspaceDir), archiveContent + archiveAddition);
  }

  // Always rewrite patterns.md if anything changed.
  if (summary.updated > 0 || summary.archived > 0) {
    writeFileSync(patternsPath(workspaceDir), serializePatterns({ ...parsed, patterns: remaining }));
  }

  // Truncate firings log on success.
  truncateFirings(workspaceDir);

  return summary;
}

export const __test__ = { parsePatterns, serializePatterns, daysBetween };
