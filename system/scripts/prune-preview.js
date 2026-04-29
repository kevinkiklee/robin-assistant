#!/usr/bin/env node
// Standalone prune-preview script. Lists what the prune job would archive
// today, without invoking an agent (saves API tokens). Reports counts and
// total bytes; nothing moves.
//
// Usage: node system/scripts/prune-preview.js
//        node system/scripts/prune-preview.js --json

import { readdirSync, statSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');
const MEM = join(REPO_ROOT, 'user-data', 'memory');

const NOW = new Date();
const TWELVE_MO_AGO = new Date(NOW.getFullYear(), NOW.getMonth() - 12, NOW.getDate());

function bucketTransactions() {
  const dir = join(MEM, 'knowledge/finance/lunch-money/transactions');
  if (!existsSync(dir)) return { candidates: [], totalBytes: 0 };
  const files = readdirSync(dir).filter((n) => /^\d{4}-\d{2}\.md$/.test(n));
  const candidates = [];
  for (const name of files) {
    const m = name.match(/^(\d{4})-(\d{2})\.md$/);
    const fileDate = new Date(parseInt(m[1], 10), parseInt(m[2], 10) - 1, 1);
    if (fileDate < TWELVE_MO_AGO) {
      const full = join(dir, name);
      candidates.push({
        path: `knowledge/finance/lunch-money/transactions/${name}`,
        bytes: statSync(full).size,
        targetArchive: `archive/transactions/${m[1]}/${name}`,
      });
    }
  }
  return { candidates, totalBytes: candidates.reduce((s, c) => s + c.bytes, 0) };
}

function bucketConversations() {
  const dir = join(MEM, 'knowledge/conversations');
  if (!existsSync(dir)) return { candidates: [], totalBytes: 0 };
  const candidates = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.md')) continue;
    const full = join(dir, name);
    const mtime = statSync(full).mtime;
    if (mtime < TWELVE_MO_AGO) {
      candidates.push({
        path: `knowledge/conversations/${name}`,
        bytes: statSync(full).size,
        mtime: mtime.toISOString(),
        targetArchive: `archive/conversations/${mtime.getFullYear()}/${name}`,
      });
    }
  }
  return { candidates, totalBytes: candidates.reduce((s, c) => s + c.bytes, 0) };
}

function bucketDecisionsJournal() {
  const candidates = [];
  for (const name of ['decisions.md', 'journal.md']) {
    const full = join(MEM, name);
    if (!existsSync(full)) continue;
    const text = readFileSync(full, 'utf-8');
    // Split by year-headed sections (## YYYY) — count entries from years
    // before the current year.
    const currentYear = NOW.getFullYear();
    const lines = text.split('\n');
    const yearSections = new Map();
    let curYear = null;
    for (const line of lines) {
      const m = line.match(/^##\s+(\d{4})\s*$/);
      if (m) {
        curYear = parseInt(m[1], 10);
        yearSections.set(curYear, []);
      } else if (curYear !== null) {
        yearSections.get(curYear).push(line);
      }
    }
    for (const [year, body] of yearSections) {
      if (year < currentYear) {
        const text = body.join('\n');
        candidates.push({
          path: `${name} (year ${year} section)`,
          bytes: Buffer.byteLength(text, 'utf8'),
          targetArchive: `archive/${name.replace('.md', '')}-${year}.md`,
        });
      }
    }
  }
  return { candidates, totalBytes: candidates.reduce((s, c) => s + c.bytes, 0) };
}

function main() {
  const json = process.argv.includes('--json');
  const tx = bucketTransactions();
  const conv = bucketConversations();
  const dj = bucketDecisionsJournal();

  const summary = {
    cutoff: TWELVE_MO_AGO.toISOString().slice(0, 10),
    transactions: tx,
    conversations: conv,
    decisions_journal_year_sections: dj,
    total_files: tx.candidates.length + conv.candidates.length + dj.candidates.length,
    total_bytes: tx.totalBytes + conv.totalBytes + dj.totalBytes,
  };

  if (json) {
    process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
    return;
  }

  console.log(`Prune preview (cutoff: ${summary.cutoff}, no changes made)`);
  console.log('');
  console.log(`Transactions to archive: ${tx.candidates.length} files (${(tx.totalBytes / 1024).toFixed(1)}KB)`);
  for (const c of tx.candidates.slice(0, 5)) console.log(`  ${c.path} → ${c.targetArchive}`);
  if (tx.candidates.length > 5) console.log(`  ... +${tx.candidates.length - 5} more`);
  console.log('');
  console.log(`Conversations to archive: ${conv.candidates.length} files (${(conv.totalBytes / 1024).toFixed(1)}KB)`);
  for (const c of conv.candidates.slice(0, 5)) console.log(`  ${c.path} → ${c.targetArchive}`);
  if (conv.candidates.length > 5) console.log(`  ... +${conv.candidates.length - 5} more`);
  console.log('');
  console.log(`Decisions/journal year sections to split: ${dj.candidates.length} (${(dj.totalBytes / 1024).toFixed(1)}KB)`);
  for (const c of dj.candidates) console.log(`  ${c.path} → ${c.targetArchive}`);
  console.log('');
  console.log(`TOTAL: ${summary.total_files} files/sections, ${(summary.total_bytes / 1024).toFixed(1)}KB`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
