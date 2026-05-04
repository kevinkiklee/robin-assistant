#!/usr/bin/env node
// check-action-captures.js — informational diagnostic.
//
// Scans `user-data/memory/streams/inbox.md` for `[action] <class> • <outcome>
// • <ref>` capture lines (per `system/rules/capture.md` `### [action] tag`).
// Reports total + per-class counts, plus whether `action-trust.md` `## Open`
// has matching entries.
//
// Always exits 0; this is a read-only signal. Dream Phase 12.5 consumes the
// "no captures in 7 days" warning to surface a banner in needs-your-input.md
// if the capture pipeline is silent.
//
// Usage:
//   npm run check-action-captures
//   ROBIN_WORKSPACE=/path node system/scripts/diagnostics/check-action-captures.js [--json]

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveCliWorkspaceDir } from '../lib/workspace-root.js';

const INBOX_REL = 'user-data/memory/streams/inbox.md';
const TRUST_REL = 'user-data/memory/self-improvement/action-trust.md';

// `[action]` line shape per capture.md:
//   [action|origin=...] <class> • <outcome> • <ref>  <!-- id:YYYYMMDD-HHMM-... -->
// `<class>` is the slug from classify.js. `<outcome>` is one of
// silent|approved|corrected|pending. `<ref>` is optional.
//
// We tolerate the bare-tag form `[action]` (no `|origin=...`) for backward
// compatibility — early captures might not carry origin yet.
const ACTION_RE = /\[action(?:\|[^\]]*)?\]\s*([a-z][a-z0-9-]*)\s*[•·]\s*(silent|approved|corrected|pending)(?:\s*[•·]\s*(\S.*?))?\s*(?:<!--\s*id:(\d{8})[^>]*-->)?\s*$/;

// Today + windowDays → cutoff date string (YYYYMMDD).
function cutoffDate(today, windowDays) {
  const t = Date.parse(`${today}T00:00:00Z`);
  if (Number.isNaN(t)) return null;
  const cutoffMs = t - windowDays * 24 * 3600 * 1000;
  const d = new Date(cutoffMs);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

function parseTrustOpenSlugs(text) {
  if (!text) return [];
  // Find ## Open section, then collect `### slug` headings within it.
  const startMatch = text.match(/^## Open\s*\n/m);
  if (!startMatch) return [];
  const startIdx = startMatch.index + startMatch[0].length;
  const rest = text.slice(startIdx);
  const nextHeading = rest.search(/^## /m);
  const body = nextHeading === -1 ? rest : rest.slice(0, nextHeading);
  const slugs = [];
  for (const m of body.matchAll(/^###\s+(.+?)\s*$/gm)) {
    slugs.push(m[1].trim());
  }
  return slugs;
}

export function scanActionCaptures(workspaceRoot, opts = {}) {
  const today = opts.today || new Date().toISOString().slice(0, 10);
  const windowDays = Number.isFinite(opts.windowDays) ? opts.windowDays : 30;
  const cutoff = cutoffDate(today, windowDays);
  const sevenAgo = cutoffDate(today, 7);
  const inboxPath = join(workspaceRoot, INBOX_REL);
  const trustPath = join(workspaceRoot, TRUST_REL);

  const report = {
    total: 0,
    byClass: {},
    byOutcome: {},
    classesWithTrustEntry: [],
    classesWithoutTrustEntry: [],
    warning7d: true,
    inboxExists: false,
    windowDays,
    today,
  };

  if (!existsSync(inboxPath)) return report;
  report.inboxExists = true;

  const text = readFileSync(inboxPath, 'utf8');
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line.includes('[action')) continue;
    const m = line.match(ACTION_RE);
    if (!m) continue;
    const cls = m[1];
    const outcome = m[2];
    const idDate = m[4]; // YYYYMMDD or undefined

    // Window filter: if id has a date and it's before cutoff, skip.
    if (cutoff && idDate && idDate < cutoff) continue;

    report.total++;
    report.byClass[cls] = (report.byClass[cls] || 0) + 1;
    report.byOutcome[outcome] = (report.byOutcome[outcome] || 0) + 1;

    if (sevenAgo && idDate && idDate >= sevenAgo) {
      report.warning7d = false;
    } else if (sevenAgo && !idDate) {
      // Undated captures: be conservative — count them as recent.
      report.warning7d = false;
    }
  }

  if (report.total === 0) {
    report.warning7d = true;
  }

  // Cross-reference with action-trust.md ## Open.
  if (existsSync(trustPath)) {
    const trustText = readFileSync(trustPath, 'utf8');
    const openSlugs = new Set(parseTrustOpenSlugs(trustText));
    for (const cls of Object.keys(report.byClass)) {
      if (openSlugs.has(cls)) report.classesWithTrustEntry.push(cls);
      else report.classesWithoutTrustEntry.push(cls);
    }
  } else {
    report.classesWithoutTrustEntry = Object.keys(report.byClass);
  }

  return report;
}

export function formatReport(report) {
  const lines = [];
  lines.push(`# Action capture diagnostic`);
  lines.push('');
  lines.push(`Window: last ${report.windowDays} days (today=${report.today})`);
  lines.push(`Total captures: ${report.total}`);
  if (report.warning7d) {
    lines.push('');
    lines.push('⚠ No [action] captures in last 7 days.');
    lines.push('  Either no AUTO/ASK actions occurred (unlikely) or the capture-emission');
    lines.push('  rule isn\'t being honored. Review system/rules/capture.md `### [action] tag`.');
  }
  lines.push('');
  lines.push('By class:');
  const classes = Object.entries(report.byClass).sort((a, b) => b[1] - a[1]);
  if (classes.length === 0) lines.push('  (none)');
  for (const [cls, n] of classes) {
    const tag = report.classesWithTrustEntry.includes(cls) ? '' : '  (no ## Open trust entry)';
    lines.push(`  ${cls}: ${n}${tag}`);
  }
  lines.push('');
  lines.push('By outcome:');
  const outcomes = Object.entries(report.byOutcome).sort((a, b) => b[1] - a[1]);
  if (outcomes.length === 0) lines.push('  (none)');
  for (const [out, n] of outcomes) lines.push(`  ${out}: ${n}`);
  return lines.join('\n');
}

const isMain = process.argv[1]
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const argv = process.argv.slice(2);
  const wantsJson = argv.includes('--json');
  const ws = resolveCliWorkspaceDir();
  const report = scanActionCaptures(ws);
  if (wantsJson) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } else {
    process.stdout.write(formatReport(report) + '\n');
  }
  process.exit(0);
}
