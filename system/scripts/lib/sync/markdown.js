import { writeFileSync, readFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { applyRedaction } from './redact.js';

const MEMORY_PREFIX = 'user-data/memory/';

function shouldRedact(relPath) {
  const norm = relPath.replace(/\\/g, '/');
  return norm.startsWith(MEMORY_PREFIX);
}

export async function atomicWrite(workspaceDir, relPath, content) {
  let body = content;
  if (shouldRedact(relPath)) {
    const { redacted, count } = applyRedaction(content);
    if (count > 0) {
      body = `<!-- redaction: ${count} matches blocked -->\n${redacted}`;
    }
  }
  const full = join(workspaceDir, relPath);
  mkdirSync(dirname(full), { recursive: true });
  const tmp = `${full}.tmp`;
  writeFileSync(tmp, body);
  renameSync(tmp, full);
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
