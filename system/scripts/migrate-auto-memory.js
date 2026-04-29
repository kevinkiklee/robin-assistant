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

import { existsSync, readFileSync, readdirSync, writeFileSync, unlinkSync, rmdirSync, statSync, appendFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');
const INBOX = join(REPO_ROOT, 'user-data/memory/inbox.md');

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
  if (entries.length === 0) return;
  // Read inbox to verify dedup (don't append a line we already migrated).
  const existing = existsSync(INBOX) ? readFileSync(INBOX, 'utf-8') : '';
  const out = [];
  for (const e of entries) {
    // Dedup: if the inbox already contains the same summary text, skip.
    if (existing.includes(e.summary) && existing.includes('migrated from')) continue;
    const line = `\n<!-- id:${e.id} -->\n- ${e.tag} ${e.summary} (migrated from ${host} auto-memory: ${e.sourceFileName})`;
    out.push(line);
  }
  if (out.length > 0) {
    appendFileSync(INBOX, out.join('') + '\n');
  }
  return out.length;
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
      const appended = appendToInbox(entries, host);
      deleteAutoMemoryDir(dir);
      report.migrated += appended ?? 0;
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
  if (apply) console.log(`Migrated: ${report.migrated} entries appended to user-data/memory/inbox.md`);
  else if (Object.values(report.by_host).some((h) => h.count > 0)) console.log(`Run with --apply to perform the migration.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

export { collectEntries, HOST_DIRS };
