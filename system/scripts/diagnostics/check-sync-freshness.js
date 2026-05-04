#!/usr/bin/env node
// Diagnostic: scan synced markdown files for missing or stale `last_synced`.
//
// The freshness contract (see system/scripts/lib/freshness.js) says every
// file written by a sync job carries `last_synced: <ISO 8601>` in its
// frontmatter. CLAUDE.md asks the model to verify that field before quoting
// fields as "today's." This diagnostic catches drift in the contract:
// sync writers that forgot to stamp, or jobs that haven't run recently.
//
// Default scan paths (per spec):
//   - user-data/memory/sync/
//   - user-data/runtime/state/sync/
//
// Some installs (Kevin's, packaged scaffold) write synced data under
// `user-data/memory/knowledge/<topic>/` instead. Pass --scan <relpath> to
// add additional roots. With --all, every *.md under user-data/memory/
// that contains a `last_synced:` line in frontmatter is scanned (used for
// pre-merge baselines).
//
// Exit 0 always — this is an informational diagnostic, not a CI gate.
// Wired into Dream Phase 12.5 (stale-sync-files section in
// needs-your-input.md).

import { existsSync, readFileSync, readdirSync, lstatSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveCliWorkspaceDir } from '../lib/workspace-root.js';
import { getLastSynced, isFresh } from '../lib/freshness.js';

const DEFAULT_SCANS = [
  'user-data/memory/sync',
  'user-data/runtime/state/sync',
];

function* walkMarkdown(dir) {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    if (name.startsWith('.')) continue;
    const full = join(dir, name);
    let st;
    try { st = lstatSync(full); } catch { continue; }
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) yield* walkMarkdown(full);
    else if (name.endsWith('.md')) yield full;
  }
}

function hasLastSyncedField(filePath) {
  try {
    const text = readFileSync(filePath, 'utf8');
    const m = text.match(/^---\n([\s\S]*?)\n---\n?/);
    if (!m) return false;
    return /^last_synced:\s*\S/m.test(m[1]);
  } catch { return false; }
}

function ageHours(iso, now = Date.now()) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return (now - t) / (3600 * 1000);
}

// Scan a list of root directories (absolute paths) and return:
//   { missing: [path], stale: [{path, ageHours, last_synced}], fresh: [path], unparseable: [path] }
//
// `missing`: file under a "scan" root with no `last_synced` field.
// `stale`: file with last_synced older than maxAgeHours.
// `fresh`: file with last_synced within window.
// `unparseable`: last_synced field present but not a valid date.
//
// `onlyWithStamp` mode (--all): include only files that already declare
// `last_synced` (i.e., already in the contract). Used for baselines.
export function scanFreshness({ workspaceDir, roots, maxAgeHours = 24, onlyWithStamp = false, now = Date.now() }) {
  const out = { missing: [], stale: [], fresh: [], unparseable: [] };
  for (const root of roots) {
    const abs = resolve(workspaceDir, root);
    for (const file of walkMarkdown(abs)) {
      const rel = relative(workspaceDir, file);
      const ts = getLastSynced(file);
      if (ts === null) {
        if (!onlyWithStamp) out.missing.push(rel);
        continue;
      }
      const ah = ageHours(ts, now);
      if (ah === null) {
        out.unparseable.push(rel);
        continue;
      }
      if (ah > maxAgeHours) {
        out.stale.push({ path: rel, age_hours: Math.round(ah * 10) / 10, last_synced: ts });
      } else {
        out.fresh.push(rel);
      }
    }
  }
  return out;
}

function parseArgs(argv) {
  const args = { scans: [...DEFAULT_SCANS], maxAgeHours: 24, all: false, json: false, workspace: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--scan' && argv[i + 1]) {
      args.scans.push(argv[++i]);
    } else if (a === '--max-age-hours' && argv[i + 1]) {
      args.maxAgeHours = Number(argv[++i]);
    } else if (a === '--all') {
      args.all = true;
    } else if (a === '--json') {
      args.json = true;
    } else if (a === '--workspace' && argv[i + 1]) {
      args.workspace = argv[++i];
    } else if (a === '--help' || a === '-h') {
      args.help = true;
    }
  }
  return args;
}

function help() {
  return [
    'Usage: check-sync-freshness [options]',
    '',
    'Scan synced markdown files for missing or stale `last_synced` frontmatter.',
    '',
    'Options:',
    '  --scan <relpath>        Add a scan root (relative to workspace). Repeatable.',
    '  --max-age-hours <hrs>   Window for "fresh" (default: 24).',
    '  --all                   Scan every *.md under user-data/memory/ and user-data/runtime/state/',
    '                          that already declares last_synced. Use for baselines.',
    '  --json                  JSON output instead of human-readable.',
    '  --workspace <dir>       Workspace dir (default: ROBIN_WORKSPACE or cwd).',
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
    process.stderr.write(`check-sync-freshness: ${err.message}\n`);
    process.exit(1);
  }

  let roots = args.scans;
  if (args.all) {
    // Walk all *.md under memory/ and runtime/state/ and keep only files
    // that already declare last_synced.
    roots = ['user-data/memory', 'user-data/runtime/state'];
  }

  const result = scanFreshness({
    workspaceDir,
    roots,
    maxAgeHours: args.maxAgeHours,
    onlyWithStamp: args.all,
  });

  if (args.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exit(0);
  }

  const lines = [];
  lines.push(`check-sync-freshness: scanned ${roots.join(', ')}`);
  lines.push(`  fresh:        ${result.fresh.length}`);
  lines.push(`  stale (>${args.maxAgeHours}h): ${result.stale.length}`);
  lines.push(`  missing stamp: ${result.missing.length}`);
  lines.push(`  unparseable:  ${result.unparseable.length}`);
  if (result.stale.length > 0) {
    lines.push('');
    lines.push('Stale files:');
    for (const s of result.stale) {
      lines.push(`  ${s.path} — ${s.age_hours}h old (last_synced: ${s.last_synced})`);
    }
  }
  if (result.missing.length > 0 && !args.all) {
    lines.push('');
    lines.push('Missing last_synced:');
    for (const p of result.missing.slice(0, 25)) lines.push(`  ${p}`);
    if (result.missing.length > 25) lines.push(`  … and ${result.missing.length - 25} more`);
  }
  if (result.unparseable.length > 0) {
    lines.push('');
    lines.push('Unparseable last_synced:');
    for (const p of result.unparseable) lines.push(`  ${p}`);
  }
  process.stdout.write(`${lines.join('\n')}\n`);
  process.exit(0);
}
