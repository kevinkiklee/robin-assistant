// Migration 0009: build sub-indexes for high-churn knowledge sub-trees;
// reflow main INDEX.md so each sub-tree shows as one row.
//
// Before: INDEX.md lists 35+ rows for lunch-money/transactions/* and other
//         per-month files. Bloats Tier 1 with churn.
// After:  Sub-indexes at:
//           knowledge/finance/lunch-money/INDEX.md
//           knowledge/photography-collection/INDEX.md
//           knowledge/events/INDEX.md
//         Main INDEX shows one row per sub-tree.
//
// The actual main-INDEX regeneration is handled by
// `regenerate-memory-index.js` which is invoked once after this migration
// completes. This script just creates the sub-indexes.
//
// Idempotent: if a sub-index already exists, leave it alone.

import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';

export const id = '0009-build-sub-indexes';
export const description = 'Build sub-indexes for high-churn knowledge sub-trees (lunch-money, photography-collection, events).';

const SUB_INDEXES = [
  {
    dir: 'user-data/memory/knowledge/finance/lunch-money',
    title: 'Lunch Money sub-index',
    description_field: 'Lunch Money — auto-pulled financial data (transactions, accounts, investments).',
    summary: 'Auto-pulled financial data — transactions, account snapshots, investment balances. One file per month for transactions; current snapshots for accounts and investments. Most queries should consult the most recent month or two.',
  },
  {
    dir: 'user-data/memory/knowledge/photography-collection',
    title: 'Photography Collection sub-index',
    description_field: 'Per-folder photo observations and the overview tracker.',
    summary: 'Per-folder photo observations — Urban Landscape, Wildlife, Astoria, Night, Protest, Pubbed, Street, Urban, Standalones — plus the collection overview and progression tracker.',
  },
  {
    dir: 'user-data/memory/knowledge/events',
    title: 'Events sub-index',
    description_field: 'Dated events — trips, attended events.',
    summary: 'Dated events: trips, conferences, attended events. One file per event using the slug pattern <slug>-<YYYY-MM>.md. Status: Planning | Booked | Completed.',
  },
];

function readFrontmatter(path) {
  if (!existsSync(path)) return null;
  const text = readFileSync(path, 'utf-8');
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return null;
  const fm = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^(\w+):\s*(.+)$/);
    if (kv) fm[kv[1]] = kv[2].replace(/^["']|["']$/g, '');
  }
  return fm;
}

function buildSubIndex(workspaceDir, cfg) {
  const dir = join(workspaceDir, cfg.dir);
  if (!existsSync(dir)) return null;

  const indexPath = join(dir, 'INDEX.md');
  if (existsSync(indexPath)) {
    return { path: indexPath, action: 'skipped' };
  }

  const entries = [];
  function walk(d, relBase) {
    if (!existsSync(d)) return;
    for (const name of readdirSync(d).sort()) {
      if (name.startsWith('.') || name === 'INDEX.md' || name === '_template.md') continue;
      const full = join(d, name);
      const rel = relBase ? `${relBase}/${name}` : name;
      const st = statSync(full);
      if (st.isDirectory()) {
        walk(full, rel);
      } else if (name.endsWith('.md')) {
        const fm = readFrontmatter(full);
        const desc = fm?.description ?? '(no description)';
        entries.push({ rel, desc });
      }
    }
  }
  walk(dir, '');

  const lines = [];
  lines.push(`---`);
  lines.push(`description: ${cfg.description_field}`);
  lines.push(`type: reference`);
  lines.push(`---`);
  lines.push('');
  lines.push(`# ${cfg.title}`);
  lines.push('');
  lines.push(cfg.summary);
  lines.push('');
  lines.push("| path | what's in it |");
  lines.push('|------|--------------|');
  for (const e of entries) lines.push(`| ${e.rel} | ${e.desc} |`);
  lines.push('');

  mkdirSync(dir, { recursive: true });
  writeFileSync(indexPath, lines.join('\n'));
  return { path: indexPath, action: 'created', entries: entries.length };
}

export async function up({ workspaceDir }) {
  for (const cfg of SUB_INDEXES) {
    const r = buildSubIndex(workspaceDir, cfg);
    if (r === null) {
      console.log(`[0009] ${cfg.dir} not present — skipping sub-index`);
    } else if (r.action === 'skipped') {
      console.log(`[0009] sub-index already exists at ${r.path} — leaving alone`);
    } else {
      console.log(`[0009] built sub-index ${r.path} with ${r.entries} entries`);
    }
  }
  console.log('[0009] note: run `npm run regenerate-memory-index` to reflow the main INDEX.md');
}
