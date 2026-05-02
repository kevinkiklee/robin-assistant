#!/usr/bin/env node
// Drains host-managed auto-memory directories into user-data/memory/inbox.md.
//
// Per the Local Memory immutable rule (AGENTS.md), persistent memory must
// live in user-data/. Some hosts write to ~/.claude/projects/.../memory/
// despite our instructions; this script migrates those entries during
// Dream's Phase 0 and removes the source.
//
// Modes:
//   (default) report what would migrate; no changes
//   --apply   actually migrate + delete source
//   --json    machine-readable output
//
// Currently handles Claude Code. Extend HOST_DIRS for other hosts that
// add a host-managed memory layer.

import { existsSync, readFileSync, readdirSync, writeFileSync, unlinkSync, rmdirSync, statSync, appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const INBOX = join(REPO_ROOT, 'user-data/memory/inbox.md');
const MIGRATION_LOG = join(REPO_ROOT, 'user-data/state/migrated-auto-memory-log.json');
const LOG_CAP = 500;

function workspaceSlug() {
  // Claude Code derives its memory dir from the workspace path with `/` → `-`.
  // Example: /Users/iser/workspace/robin/robin-assistant
  // becomes: -Users-iser-workspace-robin-robin-assistant
  return REPO_ROOT.replace(/\//g, '-');
}

const HOST_DIRS = [
  {
    host: 'claude-code',
    dir: join(homedir(), '.claude', 'projects', workspaceSlug(), 'memory'),
  },
];

function parseFrontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { fm: {}, body: text };
  const fm = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^(\w+):\s*(.+)$/);
    if (kv) fm[kv[1]] = kv[2].trim();
  }
  return { fm, body: m[2].trim() };
}

function tagFor(type) {
  // Claude Code's auto-memory uses the `type:` field in frontmatter:
  //   user      → fact about the user → [fact]
  //   feedback  → correction/preference → [preference] (Dream re-routes if it's clearly a correction)
  //   project   → project state → [fact]
  //   reference → external pointer → [fact]
  switch (type) {
    case 'user': return '[fact]';
    case 'project': return '[fact]';
    case 'reference': return '[fact]';
    case 'feedback': return '[preference]';
    default: return '[?]';
  }
}

function migrationId(host, fileName, idx) {
  const ts = new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14);
  const slug = fileName.replace(/\.md$/, '').replace(/[^a-z0-9]/gi, '').slice(0, 8);
  return `${ts.slice(0, 8)}-${ts.slice(8, 12)}-am${slug}${idx}`;
}

function normalizeSummary(s) {
  // Hash key: lowercase, strip non-alphanumerics, collapse whitespace, take first 12 tokens.
  // Goal: tolerate wording drift ("Don't summarize" vs "Do not summarize") so the same
  // semantic feedback memory hashes to the same key across sessions.
  const tokens = s
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 12);
  return tokens.join(' ');
}

function summaryHash(s) {
  return createHash('sha256').update(normalizeSummary(s)).digest('hex').slice(0, 16);
}

function loadMigrationLog() {
  if (!existsSync(MIGRATION_LOG)) return { version: 1, hashes: {} };
  try {
    const parsed = JSON.parse(readFileSync(MIGRATION_LOG, 'utf-8'));
    if (!parsed.hashes) parsed.hashes = {};
    return parsed;
  } catch {
    return { version: 1, hashes: {} };
  }
}

function saveMigrationLog(log) {
  // FIFO cap to keep the log bounded. Insertion order is preserved by JS object semantics.
  const keys = Object.keys(log.hashes);
  if (keys.length > LOG_CAP) {
    const drop = keys.slice(0, keys.length - LOG_CAP);
    for (const k of drop) delete log.hashes[k];
  }
  mkdirSync(dirname(MIGRATION_LOG), { recursive: true });
  writeFileSync(MIGRATION_LOG, JSON.stringify(log, null, 2) + '\n');
}

function inboxNormalizedHashes() {
  if (!existsSync(INBOX)) return new Set();
  const text = readFileSync(INBOX, 'utf-8');
  const out = new Set();
  for (const line of text.split('\n')) {
    const m = line.match(/^- \[[\w?]+\][^\S\n]+(.+)$/);
    if (m) out.add(summaryHash(m[1]));
  }
  return out;
}

function collectEntries(host, dir) {
  if (!existsSync(dir)) return [];
  const entries = [];
  const memoryIndex = join(dir, 'MEMORY.md');
  let idx = 0;
  for (const name of readdirSync(dir).sort()) {
    if (name === 'MEMORY.md') continue;
    if (!name.endsWith('.md')) continue;
    const path = join(dir, name);
    const text = readFileSync(path, 'utf-8');
    const { fm, body } = parseFrontmatter(text);
    const desc = fm.description ?? '';
    const tag = tagFor(fm.type);
    // Compose an inbox line: tag + first line of body (or description if body empty),
    // plus provenance.
    const firstLine = body.split('\n').find((l) => l.trim().length > 0) ?? '';
    const summary = firstLine || desc;
    const id = migrationId(host, name, idx++);
    entries.push({
      sourceFile: path,
      sourceFileName: name,
      tag,
      summary,
      fullBody: body,
      desc,
      type: fm.type,
      id,
      indexFile: existsSync(memoryIndex) ? memoryIndex : null,
    });
  }
  return entries;
}

function appendToInbox(entries, host) {
  if (entries.length === 0) return { appended: 0, skipped: 0 };
  // Two-tier dedup:
  //  1. Persistent migration log keyed by host:summaryHash. Catches re-migration after
  //     Dream has already routed the inbox entry out (the inbox no longer contains it,
  //     but we still know we've migrated this content).
  //  2. Live inbox scan keyed by summaryHash. Catches manual captures of the same fact
  //     that landed in the inbox before the auto-memory drain ran.
  // Hash uses a normalized form (lowercase, alphanumerics-only, first 12 tokens) so
  // wording drift like "Don't summarize" vs "Do not summarize" collapses to one entry.
  const log = loadMigrationLog();
  const inboxHashes = inboxNormalizedHashes();
  const out = [];
  let skipped = 0;
  for (const e of entries) {
    const h = summaryHash(e.summary);
    const logKey = `${host}:${h}`;
    if (log.hashes[logKey] || inboxHashes.has(h)) {
      skipped++;
      // Record the sighting so we still have provenance even when we skip.
      log.hashes[logKey] = log.hashes[logKey] ?? { firstSeen: new Date().toISOString(), file: e.sourceFileName, tag: e.tag };
      log.hashes[logKey].lastSeen = new Date().toISOString();
      log.hashes[logKey].seenCount = (log.hashes[logKey].seenCount ?? 1) + 1;
      continue;
    }
    const line = `\n<!-- id:${e.id} -->\n- ${e.tag} ${e.summary} (migrated from ${host} auto-memory: ${e.sourceFileName})`;
    out.push(line);
    log.hashes[logKey] = { firstSeen: new Date().toISOString(), lastSeen: new Date().toISOString(), file: e.sourceFileName, tag: e.tag, seenCount: 1 };
    inboxHashes.add(h); // prevent dup within the same batch
  }
  if (out.length > 0) {
    appendFileSync(INBOX, out.join('') + '\n');
  }
  saveMigrationLog(log);
  return { appended: out.length, skipped };
}

function deleteAutoMemoryDir(dir) {
  // Remove every .md file (including MEMORY.md) and rmdir.
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    try {
      if (statSync(p).isFile()) unlinkSync(p);
    } catch {}
  }
  try {
    rmdirSync(dir);
  } catch {
    // Non-empty (race?) — safe to leave; next Dream will retry.
  }
}

function main() {
  const apply = process.argv.includes('--apply');
  const json = process.argv.includes('--json');

  const report = { migrated: 0, by_host: {} };

  for (const { host, dir } of HOST_DIRS) {
    const entries = collectEntries(host, dir);
    if (entries.length === 0) {
      report.by_host[host] = { count: 0, dir, exists: existsSync(dir) };
      continue;
    }
    report.by_host[host] = { count: entries.length, dir, exists: true, entries: entries.map((e) => ({ source: e.sourceFileName, tag: e.tag, summary: e.summary.slice(0, 100) })) };
    if (apply) {
      const result = appendToInbox(entries, host);
      deleteAutoMemoryDir(dir);
      report.migrated += result.appended;
      report.skipped = (report.skipped ?? 0) + result.skipped;
      report.by_host[host].appended = result.appended;
      report.by_host[host].skipped = result.skipped;
    }
  }

  if (json) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    return;
  }

  console.log(`Auto-memory migration ${apply ? 'EXECUTED' : 'DRY-RUN'}`);
  for (const [host, info] of Object.entries(report.by_host)) {
    if (info.count === 0) {
      console.log(`  ${host}: 0 entries (${info.exists ? 'dir empty' : 'dir does not exist'})`);
      continue;
    }
    console.log(`  ${host}: ${info.count} entries`);
    for (const e of info.entries) console.log(`    ${e.tag} ${e.summary}`);
  }
  if (apply) {
    const skipped = report.skipped ?? 0;
    console.log(`Migrated: ${report.migrated} appended, ${skipped} skipped (dup) → user-data/memory/inbox.md`);
  } else if (Object.values(report.by_host).some((h) => h.count > 0)) console.log(`Run with --apply to perform the migration.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

export { collectEntries, HOST_DIRS, normalizeSummary, summaryHash };
