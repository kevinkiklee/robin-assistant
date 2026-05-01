import { writeFileSync, readFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { applyRedaction } from './redact.js';
import { sanitizeUntrustedString } from './sanitize-tags.js';
import { updateIndexForFile } from './untrusted-index.js';

const MEMORY_PREFIX = 'user-data/memory/';

function shouldRedact(relPath) {
  const norm = relPath.replace(/\\/g, '/');
  return norm.startsWith(MEMORY_PREFIX);
}

// Insert or update `key: value` lines inside the file's leading frontmatter.
// If no frontmatter exists, prepend one. Existing keys are replaced in place;
// new keys are appended just before the closing `---`.
function setFrontmatterKeys(body, kv) {
  const fmRe = /^---\n([\s\S]*?)\n---\n?/;
  const m = body.match(fmRe);
  if (!m) {
    const lines = Object.entries(kv).map(([k, v]) => `${k}: ${v}`);
    return `---\n${lines.join('\n')}\n---\n${body}`;
  }
  let inner = m[1];
  for (const [k, v] of Object.entries(kv)) {
    const keyRe = new RegExp(`^${k}:.*$`, 'm');
    if (keyRe.test(inner)) {
      inner = inner.replace(keyRe, `${k}: ${v}`);
    } else {
      inner = inner.length === 0 ? `${k}: ${v}` : `${inner}\n${k}: ${v}`;
    }
  }
  return body.replace(fmRe, `---\n${inner}\n---\n`);
}

// Strip leading frontmatter from a body string, returning [frontmatter, rest].
function splitFrontmatter(body) {
  const fmRe = /^(---\n[\s\S]*?\n---\n?)/;
  const m = body.match(fmRe);
  if (!m) return ['', body];
  return [m[1], body.slice(m[1].length)];
}

// Wrap body content in inline UNTRUSTED markers. Frontmatter is preserved
// outside the wrap so consumers can still read the metadata.
function wrapUntrusted(body, source) {
  const [fm, rest] = splitFrontmatter(body);
  const inner = rest.startsWith('\n') ? rest.slice(1) : rest;
  return `${fm}\n<!-- UNTRUSTED-START src=${source} -->\n${inner}<!-- UNTRUSTED-END -->\n`;
}

// atomicWrite — write a markdown file atomically (tmp + rename).
//
// Options:
//   opts.trust — 'untrusted' | 'untrusted-mixed' | undefined.
//     When set, marks the file as carrying externally-authored content.
//     Frontmatter gains `trust:` and `trust-source:` keys; body is
//     sanitized via sanitize-tags and wrapped in UNTRUSTED markers.
//   opts.trustSource — string identifier (e.g., 'sync-gmail',
//     'ingest:letterboxd-2026-04-30'). Required when `trust` is set.
//
// Existing applyRedaction flow (PII shape patterns) runs unchanged for any
// path under user-data/memory/, regardless of `trust`. The two passes are
// orthogonal: redaction strips PII shapes; trust marking signals externally-
// authored content for the agent and capture loop.
export async function atomicWrite(workspaceDir, relPath, content, opts = {}) {
  let body = content;

  // Step 1 — Untrusted handling. When opts.trust is set, sanitize and wrap
  // BEFORE redaction so the redactor sees the post-wrap text (markers around
  // the redacted PII don't matter; redaction still finds shapes inside).
  if (opts.trust === 'untrusted' || opts.trust === 'untrusted-mixed') {
    if (!opts.trustSource) {
      throw new TypeError('atomicWrite: opts.trustSource is required when opts.trust is set');
    }
    body = setFrontmatterKeys(body, {
      trust: opts.trust,
      'trust-source': opts.trustSource,
    });
    body = sanitizeUntrustedString(body);
    body = wrapUntrusted(body, opts.trustSource);
  }

  // Step 2 — PII redaction (orthogonal, applies to all memory writes).
  if (shouldRedact(relPath)) {
    const { redacted, count } = applyRedaction(body);
    if (count > 0) {
      body = `<!-- redaction: ${count} matches blocked -->\n${redacted}`;
    } else {
      body = redacted;
    }
  }

  const full = join(workspaceDir, relPath);
  mkdirSync(dirname(full), { recursive: true });
  const tmp = `${full}.tmp`;
  writeFileSync(tmp, body);
  renameSync(tmp, full);

  // Step 3 — Update the untrusted-content index for cycle-1b's outbound
  // taint check. Only files written with opts.trust contribute to the
  // haystack. Trusted writes (no opts.trust) are not indexed.
  if (opts.trust === 'untrusted' || opts.trust === 'untrusted-mixed') {
    try {
      updateIndexForFile(workspaceDir, relPath, body);
    } catch {
      // Index update is best-effort; never block the write on a stale index.
    }
  }
}

// Lazy fetch + write-once cache.
//
// Default behavior: if the file exists at `relPath`, return its contents
// without calling `fetcher`. Files only get written on first access.
//
// Options:
//   maxAgeMs — if provided, treat the cached file as stale once its mtime
//     is older than this many milliseconds. Stale files are re-fetched and
//     re-written. Use this for items whose upstream source can change
//     (e.g., a calendar event that may be edited by other attendees).
//     For items whose upstream never changes (e.g., Spotify audio features
//     for a track), omit this option — write-once is correct.
export async function openItem(workspaceDir, relPath, fetcher, opts = {}) {
  const full = join(workspaceDir, relPath);
  if (existsSync(full)) {
    if (typeof opts.maxAgeMs === 'number' && opts.maxAgeMs >= 0) {
      const ageMs = Date.now() - statSync(full).mtimeMs;
      if (ageMs <= opts.maxAgeMs) {
        return readFileSync(full, 'utf-8');
      }
      // Fall through to re-fetch.
    } else {
      return readFileSync(full, 'utf-8');
    }
  }
  const body = await fetcher();
  await atomicWrite(workspaceDir, relPath, body);
  return readFileSync(full, 'utf-8');
}

function escapeCell(s) {
  return String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

export function writeTable({ columns, rows }) {
  const header = `| ${columns.join(' | ')} |`;
  const divider = `|${columns.map(() => '---').join('|')}|`;
  const body = rows.map(
    (row) => `| ${columns.map((c) => escapeCell(row[c])).join(' | ')} |`
  );
  return [header, divider, ...body].join('\n') + '\n';
}
