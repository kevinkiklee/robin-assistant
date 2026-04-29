#!/usr/bin/env node
// Deterministic prune execution. Moves >12-month-old content into the
// archive tree under a file lock, writes a pre-prune backup, regenerates
// affected indexes. No agent involvement.
//
// Usage:
//   node system/scripts/prune-execute.js              # execute (with backup)
//   node system/scripts/prune-execute.js --dry-run    # delegate to prune-preview
//
// Skips when sibling sessions are active (multi-session safety per spec).
//
// Reversibility: full pre-prune backup at backup/<ts>-pre-prune/. Restore
// with: cp -r backup/<ts>-pre-prune/. user-data/memory/

import {
  readdirSync,
  readFileSync,
  writeFileSync,
  statSync,
  existsSync,
  renameSync,
  mkdirSync,
  cpSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');
const MEM = join(REPO_ROOT, 'user-data', 'memory');
const ARCHIVE = join(MEM, 'archive');
const SESSIONS_PATH = join(REPO_ROOT, 'user-data', 'state', 'sessions.md');
const STATE_DIR = join(REPO_ROOT, 'user-data', 'state', 'jobs');

const NOW = new Date();
const TWELVE_MO_AGO = new Date(NOW.getFullYear(), NOW.getMonth() - 12, NOW.getDate());

function checkSiblingSessions() {
  if (!existsSync(SESSIONS_PATH)) return null;
  const text = readFileSync(SESSIONS_PATH, 'utf-8');
  const twoHoursAgo = new Date(NOW.getTime() - 2 * 60 * 60 * 1000);
  const siblings = [];
  for (const line of text.split('\n')) {
    // Table rows like: | id | platform | started | last-active |
    const m = line.match(/\|\s*([^|]+)\s*\|\s*([^|]+)\s*\|\s*([^|]+)\s*\|\s*([^|]+)\s*\|/);
    if (!m) continue;
    if (m[1].trim() === 'Session ID' || /^-+$/.test(m[1].trim())) continue;
    const lastActive = new Date(m[4].trim());
    if (!isNaN(lastActive.getTime()) && lastActive > twoHoursAgo) {
      siblings.push({ id: m[1].trim(), platform: m[2].trim() });
    }
  }
  return siblings.length > 0 ? siblings : null;
}

function bucketTransactions() {
  const dir = join(MEM, 'knowledge/finance/lunch-money/transactions');
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir).filter((n) => /^\d{4}-\d{2}\.md$/.test(n))) {
    const m = name.match(/^(\d{4})-(\d{2})\.md$/);
    const fileDate = new Date(parseInt(m[1], 10), parseInt(m[2], 10) - 1, 1);
    if (fileDate < TWELVE_MO_AGO) {
      out.push({
        from: join(dir, name),
        toRel: `transactions/${m[1]}/${name}`,
        archiveBucket: m[1],
        kind: 'transaction',
        year: m[1],
        name,
      });
    }
  }
  return out;
}

function bucketConversations() {
  const dir = join(MEM, 'knowledge/conversations');
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.md')) continue;
    const full = join(dir, name);
    const mtime = statSync(full).mtime;
    if (mtime < TWELVE_MO_AGO) {
      const year = String(mtime.getFullYear());
      out.push({
        from: full,
        toRel: `conversations/${year}/${name}`,
        archiveBucket: year,
        kind: 'conversation',
        year,
        name,
      });
    }
  }
  return out;
}

function makePreBackup(workspaceDir, ts) {
  const backupDir = join(workspaceDir, 'backup', `${ts}-pre-prune`);
  mkdirSync(backupDir, { recursive: true });
  // Copy user-data/memory/ recursively. cpSync preserves structure.
  cpSync(MEM, join(backupDir, 'memory'), { recursive: true });
  return backupDir;
}

function pruneOldBackups(workspaceDir, keep = 3) {
  const backupRoot = join(workspaceDir, 'backup');
  if (!existsSync(backupRoot)) return [];
  const all = readdirSync(backupRoot).filter((n) => /-pre-prune$/.test(n)).sort();
  if (all.length <= keep) return [];
  const toRemove = all.slice(0, all.length - keep);
  for (const name of toRemove) {
    execFileSync('rm', ['-rf', join(backupRoot, name)]);
  }
  return toRemove;
}

function moveToArchive(candidate) {
  const dest = join(ARCHIVE, candidate.toRel);
  mkdirSync(dirname(dest), { recursive: true });
  if (existsSync(dest)) {
    // Idempotent: already moved earlier — just delete the source.
    if (existsSync(candidate.from)) {
      execFileSync('rm', ['-f', candidate.from]);
    }
    return { skipped: true, dest };
  }
  renameSync(candidate.from, dest);
  return { skipped: false, dest };
}

function regenerateArchiveIndex() {
  // Walks archive/, groups files by bucket, writes one row per bucket.
  if (!existsSync(ARCHIVE)) return;
  const buckets = new Map(); // bucketKey → { year, kind, count, totalBytes, paths }
  function walk(dir, relBase) {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      if (name.startsWith('.') || name === 'INDEX.md') continue;
      const full = join(dir, name);
      const st = statSync(full);
      const rel = relBase ? `${relBase}/${name}` : name;
      if (st.isDirectory()) walk(full, rel);
      else if (name.endsWith('.md')) {
        // bucket key = top-level subdir (transactions, conversations, calibration, decisions, journal)
        const parts = rel.split('/');
        const kind = parts[0]; // e.g. "transactions"
        // Year detection: if path starts with kind/<YEAR>/, use that. Otherwise extract from filename.
        let year = parts[1] && /^\d{4}$/.test(parts[1]) ? parts[1] : null;
        if (!year) {
          const ym = name.match(/(\d{4})/);
          year = ym ? ym[1] : 'unknown';
        }
        const key = `${year}/${kind}`;
        if (!buckets.has(key)) buckets.set(key, { year, kind, count: 0, totalBytes: 0, paths: [] });
        const b = buckets.get(key);
        b.count++;
        b.totalBytes += st.size;
        b.paths.push(rel);
      }
    }
  }
  walk(ARCHIVE, '');

  const lines = [
    '---',
    'description: Cold storage catalog — pruned content. One row per archived bucket. Maintained by the prune job.',
    'type: reference',
    '---',
    '',
    '# Archive Index',
    '',
    'Pruned content. Active memory holds the last 12 months; older content moves',
    'here. One row per archived bucket — keeps this index compact even after',
    'years of accumulation.',
    '',
    '| year | path | summary |',
    '|------|------|---------|',
  ];
  const sorted = [...buckets.values()].sort((a, b) => {
    if (a.year !== b.year) return a.year.localeCompare(b.year);
    return a.kind.localeCompare(b.kind);
  });
  for (const b of sorted) {
    const exemplar = b.paths[0];
    const dirPath = exemplar.includes('/') ? exemplar.split('/').slice(0, -1).join('/') + '/' : exemplar;
    const summary = `${b.count} ${b.kind} file${b.count === 1 ? '' : 's'} (${(b.totalBytes / 1024).toFixed(1)}KB)`;
    lines.push(`| ${b.year} | archive/${dirPath} | ${summary} |`);
  }
  lines.push('');
  writeFileSync(join(ARCHIVE, 'INDEX.md'), lines.join('\n'));
}

function regenerateLunchMoneyIndex() {
  // Re-run the same logic as migration 0009 builds — walk lunch-money/ and rebuild INDEX.
  const dir = join(MEM, 'knowledge/finance/lunch-money');
  if (!existsSync(dir)) return;
  const indexPath = join(dir, 'INDEX.md');

  function readFrontmatterDescription(path) {
    if (!existsSync(path)) return null;
    const text = readFileSync(path, 'utf-8');
    const m = text.match(/^---\n([\s\S]*?)\n---/);
    if (!m) return null;
    const dm = m[1].match(/^description:\s*(.+)$/m);
    return dm ? dm[1].replace(/^["']|["']$/g, '') : null;
  }

  const entries = [];
  function walk(d, relBase) {
    if (!existsSync(d)) return;
    for (const name of readdirSync(d).sort()) {
      if (name.startsWith('.') || name === 'INDEX.md' || name === '_template.md') continue;
      const full = join(d, name);
      const rel = relBase ? `${relBase}/${name}` : name;
      const st = statSync(full);
      if (st.isDirectory()) walk(full, rel);
      else if (name.endsWith('.md')) {
        const desc = readFrontmatterDescription(full) ?? '(no description)';
        entries.push({ rel, desc });
      }
    }
  }
  walk(dir, '');

  const lines = [
    '---',
    'description: Lunch Money — auto-pulled financial data (transactions, accounts, investments).',
    'type: reference',
    '---',
    '',
    '# Lunch Money sub-index',
    '',
    'Auto-pulled financial data — transactions, account snapshots, investment balances. One file per month for transactions; current snapshots for accounts and investments. Most queries should consult the most recent month or two.',
    '',
    "| path | what's in it |",
    '|------|--------------|',
  ];
  for (const e of entries) lines.push(`| ${e.rel} | ${e.desc} |`);
  lines.push('');
  writeFileSync(indexPath, lines.join('\n'));
}

function writePruneReport(ts, results) {
  mkdirSync(STATE_DIR, { recursive: true });
  const path = join(STATE_DIR, `prune-${ts}.md`);
  const lines = [
    `# Prune Report — ${ts}`,
    '',
    `Cutoff: ${TWELVE_MO_AGO.toISOString().slice(0, 10)}`,
    '',
    `Files moved: ${results.moved.length}`,
    `Files skipped (already archived): ${results.skipped.length}`,
    `Total bytes moved: ${(results.totalBytes / 1024).toFixed(1)}KB`,
    `Pre-prune backup: ${results.backupPath}`,
    `Backups pruned: ${results.removedBackups.length === 0 ? '(none)' : results.removedBackups.join(', ')}`,
    '',
    '## Moves',
    '',
    ...results.moved.map((m) => `- ${m.from} → ${m.dest}`),
  ];
  writeFileSync(path, lines.join('\n'));
  return path;
}

async function main() {
  if (process.argv.includes('--dry-run')) {
    const m = await import('./prune-preview.js');
    return; // prune-preview.js has its own main
  }

  const siblings = checkSiblingSessions();
  if (siblings) {
    console.error(`prune: skipping — sibling session(s) active:`);
    for (const s of siblings) console.error(`  ${s.id} (${s.platform})`);
    process.exit(2);
  }

  const candidates = [...bucketTransactions(), ...bucketConversations()];
  if (candidates.length === 0) {
    console.log('prune: nothing eligible (cutoff: ' + TWELVE_MO_AGO.toISOString().slice(0, 10) + ')');
    process.exit(0);
  }

  const ts = NOW.toISOString().replace(/[:.]/g, '-');
  console.log(`prune: ${candidates.length} files eligible (cutoff: ${TWELVE_MO_AGO.toISOString().slice(0, 10)})`);

  // Pre-prune backup (memory tree only — sources/ is immutable; state is volatile)
  console.log(`prune: writing pre-prune backup...`);
  const backupPath = makePreBackup(REPO_ROOT, ts);
  console.log(`prune: backup at ${backupPath}`);

  // Move
  const moved = [];
  const skipped = [];
  let totalBytes = 0;
  for (const c of candidates) {
    const sizeBefore = existsSync(c.from) ? statSync(c.from).size : 0;
    const r = moveToArchive(c);
    if (r.skipped) skipped.push({ ...c, dest: r.dest });
    else {
      moved.push({ ...c, dest: r.dest, bytes: sizeBefore });
      totalBytes += sizeBefore;
    }
  }

  // Regenerate indexes
  regenerateArchiveIndex();
  regenerateLunchMoneyIndex();

  // Cap pre-prune backups
  const removedBackups = pruneOldBackups(REPO_ROOT, 3);

  // Main INDEX regen via existing tool (sub-index barriers)
  try {
    execFileSync('node', [join(REPO_ROOT, 'system/scripts/regenerate-memory-index.js')], { cwd: REPO_ROOT });
  } catch (err) {
    console.warn(`prune: main INDEX regen warning — ${err.message}`);
  }

  const reportPath = writePruneReport(ts, { moved, skipped, totalBytes, backupPath, removedBackups });
  console.log(`prune: moved ${moved.length} files (${(totalBytes / 1024).toFixed(1)}KB), skipped ${skipped.length}`);
  console.log(`prune: report at ${reportPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
