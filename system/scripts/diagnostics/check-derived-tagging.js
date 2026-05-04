#!/usr/bin/env node
// Lint: forbid `[fact|origin=<derived-source>]` captures.
//
// Per system/rules/capture.md `### Derived sources (low trust for identity
// claims)`, captures from browsing history, subscription/follow lists, app
// installs, forum visit counts, and email frequency are CORRELATIONAL
// signals only. They cannot be promoted to identity, taste, or behavior
// assertions without explicit user confirmation. Such captures must use
// `[?|origin=<derived-source>]`, not `[fact|origin=<derived-source>]`.
//
// This lint scans inbox.md plus recent direct-write files (last 30 days)
// and exits non-zero on violations.
//
// Suppression: append `# allow-derived-fact: <reason>` on the same line to
// mark a legitimate exception (rare; e.g., user explicitly confirmed).
//
// Exit 0: clean. Exit 1: violations.
//
// Wired into CI via npm run check-derived-tagging.

import { existsSync, readFileSync, readdirSync, lstatSync, mkdirSync, appendFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveCliWorkspaceDir } from '../lib/workspace-root.js';

// The known low-trust origin tokens. Matching is exact-prefix on the
// `origin=` value: "sync:chrome", "sync:youtube" (subscription lists),
// "sync:spotify" (follow lists), "ingest:browsing-history",
// "tool:app-inventory", and the bare "derived" token.
//
// Tags from non-derived sync sources (sync:gmail, sync:calendar, sync:nhl,
// sync:whoop, etc.) can legitimately produce `[fact]` captures because the
// underlying data is direct observation rather than correlational signal.
//
// Default list ships intentionally narrow — extend in user-data via
// CLAUDE.md amendments or a future `recall-domains.md`-style config.
export const DERIVED_ORIGINS = [
  'derived',
  'sync:chrome',
  'sync:youtube',
  'sync:spotify',
  'ingest:browsing-history',
  'tool:app-inventory',
];

// Match `[fact|...|origin=<value>]` or `[fact|origin=<value>|...]`. The tag
// can carry arbitrary additional pipe-delimited fields. Capture group 1 is
// the origin value (everything from `origin=` up to the next `|` or `]`).
const FACT_ORIGIN_RE = /\[fact[^\]]*\borigin=([^|\]]+)/g;

const ALLOW_COMMENT_RE = /#\s*allow-derived-fact\b/;

// Files scanned by default. inbox.md is always scanned. Direct-write
// destinations come from system/rules/capture.md routing table, narrowed
// to the files that would carry inline `[tag]` content (most direct-writes
// route to topic files where the tag is stripped during routing).
const DEFAULT_SCAN_FILES = [
  'user-data/memory/streams/inbox.md',
];

// Recursively scan a directory for .md files modified in the last
// `maxAgeDays` days. Used to widen the default scan to recent direct-writes.
function* recentMarkdown(dir, maxAgeDays = 30, now = Date.now()) {
  if (!existsSync(dir)) return;
  const cutoff = now - maxAgeDays * 24 * 3600 * 1000;
  for (const name of readdirSync(dir)) {
    if (name.startsWith('.')) continue;
    const full = join(dir, name);
    let st;
    try { st = lstatSync(full); } catch { continue; }
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) yield* recentMarkdown(full, maxAgeDays, now);
    else if (name.endsWith('.md') && st.mtimeMs >= cutoff) yield full;
  }
}

// Returns array of violations: { file, line, lineNumber, origin, expected }.
export function scanFile(filePath, derivedOrigins = DERIVED_ORIGINS) {
  if (!existsSync(filePath)) return [];
  let text;
  try { text = readFileSync(filePath, 'utf8'); } catch { return []; }
  const lines = text.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (ALLOW_COMMENT_RE.test(line)) continue;
    FACT_ORIGIN_RE.lastIndex = 0;
    let m;
    while ((m = FACT_ORIGIN_RE.exec(line)) !== null) {
      const origin = m[1].trim();
      if (derivedOrigins.includes(origin) || derivedOrigins.some((d) => origin === d)) {
        out.push({
          file: filePath,
          line,
          lineNumber: i + 1,
          origin,
          expected: line.replace(/\[fact\b/, '[?'),
        });
      }
    }
  }
  return out;
}

export function scanWorkspace({ workspaceDir, files, scanRecentDirs = [], recentDays = 30, derivedOrigins = DERIVED_ORIGINS }) {
  const violations = [];
  let scanned = 0;
  for (const rel of files) {
    const abs = resolve(workspaceDir, rel);
    if (!existsSync(abs)) continue;
    scanned++;
    violations.push(...scanFile(abs, derivedOrigins));
  }
  for (const rel of scanRecentDirs) {
    const abs = resolve(workspaceDir, rel);
    for (const file of recentMarkdown(abs, recentDays)) {
      scanned++;
      violations.push(...scanFile(file, derivedOrigins));
    }
  }
  return { scanned, violations };
}

function appendDerivedTaggingLog(workspaceDir, entry) {
  try {
    const file = join(workspaceDir, 'user-data/runtime/state/telemetry/derived-tagging.log');
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${JSON.stringify(entry)}\n`);
  } catch { /* best-effort */ }
}

function parseArgs(argv) {
  const args = { workspace: null, json: false, scanRecent: true, recentDays: 30 };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--workspace' && argv[i + 1]) args.workspace = argv[++i];
    else if (a === '--json') args.json = true;
    else if (a === '--no-scan-recent') args.scanRecent = false;
    else if (a === '--recent-days' && argv[i + 1]) args.recentDays = Number(argv[++i]);
    else if (a === '--help' || a === '-h') args.help = true;
  }
  return args;
}

function help() {
  return [
    'Usage: check-derived-tagging [options]',
    '',
    'Lint inbox.md and recent direct-writes for `[fact|origin=<derived-source>]`',
    'violations. Such tags must use `[?|origin=<derived-source>]` instead.',
    'See system/rules/capture.md `### Derived sources` for the rule.',
    '',
    'Options:',
    '  --workspace <dir>     Workspace dir (default: ROBIN_WORKSPACE or cwd).',
    '  --no-scan-recent      Only scan inbox.md (skip recent direct-write scan).',
    '  --recent-days <n>     Recent-direct-write window in days (default: 30).',
    '  --json                JSON output instead of human-readable.',
    '',
    'Suppress a single violation by appending `# allow-derived-fact: <reason>`',
    'on the same line.',
    '',
  ].join('\n');
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const args = parseArgs(process.argv);
  if (args.help) {
    process.stdout.write(help());
    process.exit(0);
  }

  let workspaceDir;
  try {
    workspaceDir = args.workspace ? resolve(args.workspace) : resolveCliWorkspaceDir();
  } catch (err) {
    process.stderr.write(`check-derived-tagging: ${err.message}\n`);
    process.exit(1);
  }

  const recentDirs = args.scanRecent
    ? ['user-data/memory/profile', 'user-data/memory/knowledge']
    : [];

  const { scanned, violations } = scanWorkspace({
    workspaceDir,
    files: DEFAULT_SCAN_FILES,
    scanRecentDirs: recentDirs,
    recentDays: args.recentDays,
  });

  appendDerivedTaggingLog(workspaceDir, {
    ts: new Date().toISOString(),
    event: 'scan',
    files_scanned: scanned,
    violations: violations.length,
  });

  if (args.json) {
    const norm = violations.map((v) => ({
      file: relative(workspaceDir, v.file),
      line: v.lineNumber,
      origin: v.origin,
      content: v.line,
    }));
    process.stdout.write(`${JSON.stringify({ scanned, violations: norm }, null, 2)}\n`);
    process.exit(violations.length === 0 ? 0 : 1);
  }

  if (violations.length === 0) {
    process.stdout.write(`check-derived-tagging: OK (scanned ${scanned} files)\n`);
    process.exit(0);
  }

  process.stderr.write(`check-derived-tagging: ${violations.length} violation(s) (scanned ${scanned} files):\n`);
  for (const v of violations) {
    const rel = relative(workspaceDir, v.file);
    process.stderr.write(`  ${rel}:${v.lineNumber} — origin=${v.origin}\n`);
    process.stderr.write(`    ${v.line.trim()}\n`);
    appendDerivedTaggingLog(workspaceDir, {
      ts: new Date().toISOString(),
      event: 'violation',
      file: rel,
      line: v.lineNumber,
      origin: v.origin,
    });
  }
  process.stderr.write('\nFix: change `[fact` to `[?` on the offending line, OR append `# allow-derived-fact: <reason>` if the assertion is genuinely user-confirmed.\n');
  process.exit(1);
}
