// system/scripts/memory/lib/recall.js
//
// Node-native in-process retrieval over user-data/memory/.
// No ripgrep dependency; uses fs.readdir walk + compiled regex.

import { readFileSync, readdirSync, lstatSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

const DEFAULT_TOP_N = 5;

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function* walkMarkdown(dir) {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    if (name.startsWith('.')) continue;
    const full = join(dir, name);
    let st;
    try { st = lstatSync(full); } catch { continue; }
    // Skip symlinks: prevents memDir escape and cycle infinite-recursion.
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) {
      yield* walkMarkdown(full);
    } else if (name.endsWith('.md')) {
      yield full;
    }
  }
}

function parseFrontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return null;
  const fm = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^(\w+):\s*(.+)$/);
    if (kv) fm[kv[1].trim()] = kv[2].trim();
  }
  return fm;
}

export function recall(workspaceDir, patterns, opts = {}) {
  const topN = opts.topN ?? DEFAULT_TOP_N;
  // Empty patterns would compile to a zero-width "match every line" regex.
  if (!patterns?.length) return { hits: [], truncated: false };
  const memDir = join(workspaceDir, 'user-data/memory');
  const re = new RegExp(`\\b(${patterns.map(escapeRegex).join('|')})\\b`, 'i');
  const hits = [];
  let truncated = false;

  outer: for (const file of walkMarkdown(memDir)) {
    let text;
    try { text = readFileSync(file, 'utf8'); } catch { continue; }
    const fm = parseFrontmatter(text);
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!re.test(line)) continue;
      hits.push({
        file: relative(workspaceDir, file),
        line: i + 1,
        text: line.trim(),
        last_verified: fm?.last_verified,
      });
      if (hits.length >= topN) {
        truncated = true;
        break outer;
      }
    }
  }

  return { hits, truncated };
}

export function formatRecallHits({ hits, truncated }) {
  if (!hits.length) return '';
  const lines = hits.map((h) => {
    const verified = h.last_verified ? ` (last_verified: ${h.last_verified})` : '';
    return `- ${h.file}:${h.line} — "${h.text}"${verified}`;
  });
  if (truncated) lines.push(`(more matches truncated; run "robin recall <term>" for full)`);
  return lines.join('\n');
}
