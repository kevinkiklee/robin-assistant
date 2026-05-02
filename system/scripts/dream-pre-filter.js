#!/usr/bin/env node
// Dream pre-filter — runs before any Dream routing of user-data/memory/inbox.md.
//
// Cycle-1a's capture-loop attribution layer. Every inbox tag line carries an
// `origin=...` field (per AGENTS.md capture rule). The pre-filter:
//   1. Parses bullet-style tag lines: `- [<tag>(|<modifiers>)?] <content>`.
//   2. Reads `origin=` from the modifiers.
//   3. Lines whose origin is `user` or `user|legacy` (the migration tag) stay
//      in inbox.md.
//   4. Lines with `origin=derived` stay in inbox AND get logged to quarantine
//      for retrospective audit (no block, just visibility).
//   5. Lines with `origin=sync:*`, `origin=ingest:*`, or `origin=tool:*` are
//      moved to user-data/memory/quarantine/captures.md and removed from
//      inbox.md.
//   6. Lines without any `origin=` field — post-migration this is a violation
//      (model failed to attribute). Quarantine them.
//
// Quarantine row format: `| timestamp | origin | tag | content (truncated) |
//   source-pointer |` — content is truncated to 80 chars and run through
// applyRedaction so PII shapes don't re-inject. Deterministic — no model call.
//
// Idempotent: rerunning on already-filtered inbox is a no-op (no lines move).

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyRedaction } from './sync/lib/redact.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');

const INBOX_REL = 'user-data/memory/inbox.md';
const QUARANTINE_REL = 'user-data/memory/quarantine/captures.md';

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

// Parse a tag bullet line.
//   Returns null for non-tag lines (headings, paragraphs, blank lines).
//   Returns { tag, modifiers, origin, content } for tag lines.
//
// Match shape: `- [<tag>(|<modifiers>)?] <content>` (optionally with secondary
// tag prefix like `[movies]` after the primary tag).
function parseTagLine(line) {
  const m = line.match(/^(\s*-\s+)\[([a-z?]+)((?:\|[^\]]+)?)\]\s*(.*)$/i);
  if (!m) return null;
  const [, , tag, modifiers, content] = m;
  let origin = null;
  if (modifiers) {
    const om = modifiers.match(/\|origin=([^|\]]+)/);
    if (om) origin = om[1];
  }
  return { tag, modifiers, origin, content };
}

// origin classification: returns 'allow', 'allow-with-audit', 'quarantine'.
function classifyOrigin(origin) {
  if (origin === null || origin === undefined) {
    // Missing origin post-migration = violation.
    return 'quarantine';
  }
  if (origin === 'user' || origin.startsWith('user|legacy')) return 'allow';
  if (origin === 'derived') return 'allow-with-audit';
  if (origin.startsWith('sync:') || origin.startsWith('ingest:') || origin.startsWith('tool:')) {
    return 'quarantine';
  }
  // Unknown origin shape — fail closed.
  return 'quarantine';
}

function paraphraseContent(content) {
  const truncated = content.length > 80 ? content.slice(0, 77) + '...' : content;
  const { redacted } = applyRedaction(truncated);
  // Escape pipes so the row stays valid markdown table syntax.
  return redacted.replace(/\|/g, '\\|');
}

function ensureQuarantineFile(workspaceDir) {
  const full = join(workspaceDir, QUARANTINE_REL);
  if (existsSync(full)) return;
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, QUARANTINE_HEADER);
}

function appendQuarantineRow(workspaceDir, { origin, tag, content, sourcePointer = INBOX_REL }) {
  const full = join(workspaceDir, QUARANTINE_REL);
  const ts = new Date().toISOString();
  const row = `| ${ts} | ${origin ?? 'missing'} | ${tag} | ${paraphraseContent(content)} | ${sourcePointer} |\n`;
  writeFileSync(full, row, { flag: 'a' });
}

export function preFilter(workspaceDir) {
  const inboxPath = join(workspaceDir, INBOX_REL);
  if (!existsSync(inboxPath)) {
    return { quarantined: 0, audited: 0, kept: 0, reason: 'no-inbox' };
  }
  const original = readFileSync(inboxPath, 'utf-8');
  const lines = original.split('\n');
  const outLines = [];
  let quarantined = 0;
  let audited = 0;
  let kept = 0;

  for (const line of lines) {
    const parsed = parseTagLine(line);
    if (!parsed) {
      outLines.push(line);
      continue;
    }
    const verdict = classifyOrigin(parsed.origin);
    if (verdict === 'quarantine') {
      ensureQuarantineFile(workspaceDir);
      appendQuarantineRow(workspaceDir, {
        origin: parsed.origin,
        tag: parsed.tag,
        content: parsed.content,
      });
      quarantined += 1;
      // line is dropped from inbox.
      continue;
    }
    if (verdict === 'allow-with-audit') {
      ensureQuarantineFile(workspaceDir);
      appendQuarantineRow(workspaceDir, {
        origin: parsed.origin,
        tag: parsed.tag,
        content: parsed.content,
      });
      audited += 1;
      outLines.push(line);
      continue;
    }
    // allow
    outLines.push(line);
    kept += 1;
  }

  if (quarantined > 0) {
    writeFileSync(inboxPath, outLines.join('\n'));
  }
  return { quarantined, audited, kept };
}

// CLI entrypoint.
if (import.meta.url === `file://${process.argv[1]}`) {
  const workspaceDir = process.env.ROBIN_WORKSPACE || REPO_ROOT;
  const result = preFilter(workspaceDir);
  console.log(`[dream-pre-filter] quarantined=${result.quarantined} audited=${result.audited} kept=${result.kept}`);
  process.exit(0);
}
