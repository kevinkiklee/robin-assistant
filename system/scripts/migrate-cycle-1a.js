#!/usr/bin/env node
// Cycle-1a migration — runs once after deployment.
//
// 1. Stamps every existing inbox.md tag line with `origin=user|legacy` if it
//    lacks an origin field. Pre-cycle-1a captures represent Kevin's intent;
//    quarantining them retroactively would lose data.
// 2. Creates user-data/memory/quarantine/ + an empty captures.md template if
//    absent, so dream-pre-filter has a target on first quarantine.
//
// Idempotent: rerunnable. Lines already carrying origin= are untouched.
// Skipped: sync-written knowledge files. The next sync run rewrites them via
// atomicWrite with trust:untrusted markers — no manual rewrite needed.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');

const INBOX_REL = 'user-data/memory/inbox.md';
const QUARANTINE_DIR_REL = 'user-data/memory/quarantine';
const QUARANTINE_FILE_REL = 'user-data/memory/quarantine/captures.md';

const QUARANTINE_HEADER = `---
description: Captures Dream pre-filter refused to route (non-user origin)
type: quarantine
---

# Captures Quarantine

Append-only audit log of inbox lines whose \`origin=\` indicated synced,
ingested, or tool-sourced content. Surface in morning briefing for review.

| timestamp | origin | tag | content (paraphrased + redacted) | source-pointer |
|---|---|---|---|---|
`;

// Stamp a tag line with origin=user|legacy if it lacks any origin attribute.
function stampLine(line) {
  // Match `- [tag(...)]` shape; skip non-tag lines.
  const m = line.match(/^(\s*-\s+)\[([a-z?]+)((?:\|[^\]]+)?)\](\s*)(.*)$/i);
  if (!m) return line;
  const [, prefix, tag, modifiers, ws, content] = m;
  if (modifiers && modifiers.includes('|origin=')) {
    return line;  // already has origin
  }
  // Append |origin=user|legacy to the modifiers section.
  const newModifiers = (modifiers || '') + '|origin=user|legacy';
  return `${prefix}[${tag}${newModifiers}]${ws}${content}`;
}

function migrateInbox(workspaceDir) {
  const path = join(workspaceDir, INBOX_REL);
  if (!existsSync(path)) {
    return { stamped: 0, kept: 0, reason: 'no-inbox' };
  }
  const original = readFileSync(path, 'utf-8');
  const lines = original.split('\n');
  let stamped = 0;
  let kept = 0;
  const out = lines.map((line) => {
    const newLine = stampLine(line);
    if (newLine !== line) stamped += 1;
    else if (/^\s*-\s+\[/.test(line)) kept += 1;
    return newLine;
  });
  if (stamped > 0) {
    writeFileSync(path, out.join('\n'));
  }
  return { stamped, kept };
}

function ensureQuarantine(workspaceDir) {
  const filePath = join(workspaceDir, QUARANTINE_FILE_REL);
  if (existsSync(filePath)) return { created: false };
  mkdirSync(join(workspaceDir, QUARANTINE_DIR_REL), { recursive: true });
  writeFileSync(filePath, QUARANTINE_HEADER);
  return { created: true };
}

export function migrateCycle1a(workspaceDir) {
  const inboxResult = migrateInbox(workspaceDir);
  const quarantineResult = ensureQuarantine(workspaceDir);
  return { inbox: inboxResult, quarantine: quarantineResult };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const workspaceDir = process.env.ROBIN_WORKSPACE || REPO_ROOT;
  const result = migrateCycle1a(workspaceDir);
  console.log('[migrate-cycle-1a] inbox stamped:', result.inbox.stamped, 'kept:', result.inbox.kept ?? 0);
  console.log('[migrate-cycle-1a] quarantine created:', result.quarantine.created);
  process.exit(0);
}
