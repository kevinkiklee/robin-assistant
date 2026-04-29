#!/usr/bin/env node
// Memory-tree lint: detects orphan files (not in any INDEX) and sub-trees
// that are large enough to need their own sub-index.
//
// Modes:
//   (default) report issues, exit 1 if any hard issues
//   --json    machine-readable output
//
// Hard fails (exit 1):
//   - File under user-data/memory/ that doesn't appear in any INDEX
//   - INDEX.md that lists a path which no longer exists
//   - Sub-tree with >15 .md siblings at one level (suggests sub-index needed)
//
// The token harness handles the "INDEX too long" check. This file handles
// the structural integrity checks.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');
const MEM_ROOT = join(REPO_ROOT, 'user-data', 'memory');

const SKIP_NAMES = new Set(['INDEX.md', 'LINKS.md', 'log.md', 'hot.md', '.gitkeep', 'inbox.md']);
const SUB_TREE_THRESHOLD = 15;

function listMd(dir, base = dir, out = [], stopAtSubIndex = false) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name.startsWith('.')) continue;
    if (SKIP_NAMES.has(name)) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      const subIndex = join(full, 'INDEX.md');
      if (stopAtSubIndex && existsSync(subIndex)) {
        // Don't descend; sub-index handles it.
        continue;
      }
      listMd(full, base, out, stopAtSubIndex);
    } else if (name.endsWith('.md')) {
      out.push(relative(base, full).split(/[\\/]/).join('/'));
    }
  }
  return out;
}

function indexEntries(indexPath) {
  if (!existsSync(indexPath)) return [];
  const text = readFileSync(indexPath, 'utf-8');
  const out = [];
  for (const line of text.split('\n')) {
    const m = line.match(/^\|\s*([^|]+?)\s*\|/);
    if (m && !/^\s*-+\s*$/.test(m[1]) && m[1] !== 'path') {
      out.push(m[1]);
    }
  }
  return out;
}

function findSubTreesNeedingIndex(memRoot) {
  const issues = [];
  // A sub-tree needs its own INDEX when it has many siblings *at one level*.
  // Recursive descent (e.g., knowledge/ totals) doesn't count — those are
  // distinct sub-trees that may already be sub-indexed.
  function walk(dir) {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      if (name.startsWith('.') || SKIP_NAMES.has(name)) continue;
      const full = join(dir, name);
      const st = statSync(full);
      if (!st.isDirectory()) continue;
      const hasOwnIndex = existsSync(join(full, 'INDEX.md'));
      if (!hasOwnIndex) {
        const directSiblings = readdirSync(full).filter(
          (n) => !n.startsWith('.') && !SKIP_NAMES.has(n) && n.endsWith('.md'),
        );
        if (directSiblings.length >= SUB_TREE_THRESHOLD) {
          issues.push({
            severity: 'hard',
            message: `Sub-tree ${relative(memRoot, full)} has ${directSiblings.length} sibling .md files but no INDEX.md`,
          });
        }
      }
      // Don't descend past sub-indexes (they're encapsulated).
      if (!hasOwnIndex) walk(full);
    }
  }
  walk(memRoot);
  return issues;
}

function findOrphans(memRoot) {
  // All .md files (deep-listing, but stop at sub-indexes).
  const allFiles = listMd(memRoot, memRoot, [], true);
  // Collect paths claimed by main INDEX + sub-indexes.
  const mainIndex = join(memRoot, 'INDEX.md');
  const claimed = new Set();
  for (const e of indexEntries(mainIndex)) {
    claimed.add(e);
    if (e.endsWith('/INDEX.md')) {
      const subDir = join(memRoot, dirname(e));
      const subIndexFull = join(memRoot, e);
      const subEntries = indexEntries(subIndexFull);
      for (const se of subEntries) {
        // Sub-index entries are relative to the sub-tree
        claimed.add(relative(memRoot, join(subDir, se)));
      }
    }
  }
  // Look at each top-level sub-dir for its own INDEX too (in case main INDEX
  // doesn't list it explicitly).
  for (const top of readdirSync(memRoot)) {
    const subIndex = join(memRoot, top, 'INDEX.md');
    if (!existsSync(subIndex)) continue;
    for (const se of indexEntries(subIndex)) {
      claimed.add(relative(memRoot, join(memRoot, top, se)));
    }
  }
  const issues = [];
  for (const f of allFiles) {
    if (!claimed.has(f)) {
      issues.push({ severity: 'hard', message: `Orphan file (not in any INDEX): ${f}` });
    }
  }
  return issues;
}

function findStaleIndexEntries(memRoot) {
  const mainIndex = join(memRoot, 'INDEX.md');
  const issues = [];
  for (const e of indexEntries(mainIndex)) {
    const full = join(memRoot, e);
    if (!existsSync(full)) {
      issues.push({ severity: 'hard', message: `INDEX lists missing path: ${e}` });
    }
  }
  return issues;
}

function findOrphanTmpFiles(memRoot) {
  // Atomic writes use *.tmp + rename. An orphan .tmp suggests an interrupted
  // write — flag it so the user knows something went wrong.
  const issues = [];
  function walk(dir) {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const st = statSync(full);
      if (st.isDirectory()) {
        walk(full);
      } else if (name.endsWith('.tmp')) {
        issues.push({
          severity: 'soft',
          message: `Orphan tmp file (interrupted atomic write?): ${relative(memRoot, full)}`,
        });
      }
    }
  }
  walk(memRoot);
  return issues;
}

function main() {
  const json = process.argv.includes('--json');
  const issues = [
    ...findOrphans(MEM_ROOT),
    ...findSubTreesNeedingIndex(MEM_ROOT),
    ...findStaleIndexEntries(MEM_ROOT),
    ...findOrphanTmpFiles(MEM_ROOT),
  ];
  if (json) {
    process.stdout.write(JSON.stringify({ issues }, null, 2) + '\n');
  } else {
    if (issues.length === 0) {
      console.log('Memory lint passed.');
    } else {
      console.log(`Memory lint failed: ${issues.length} issues`);
      for (const i of issues) console.log(`  [${i.severity}] ${i.message}`);
    }
  }
  const anyHard = issues.some((i) => i.severity === 'hard');
  process.exit(anyHard ? 1 : 0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

export { findOrphans, findSubTreesNeedingIndex, findStaleIndexEntries };
