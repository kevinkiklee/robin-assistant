#!/usr/bin/env node
// Token-budget measurement harness.
//
// Modes:
//   (no flags)            print human-readable snapshot
//   --json                machine-readable snapshot
//   --check               exit non-zero if budget/caps exceeded (only when enforce_caps: true)
//   --diff                diff against committed baseline (token-baselines.json)
//   --diff-against=<ref>  diff against this script's output at a given git ref
//   --update-baseline     overwrite committed baseline with current snapshot (requires CHANGELOG entry, enforced by reviewer)
//   --host=<name>         include that host's pointer files in tier 1 (validates per-host load)
//
// Reads tier classification from system/scripts/lib/token-budget.json.
// Bytes is the primary metric; tokens are derived (see lib/tokenizer.js).

import { readFileSync, existsSync, writeFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { glob } from 'node:fs/promises';

import { measure, countBytes, countLines, estimateTokens } from './lib/tokenizer.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..', '..');

const BUDGET_PATH = join(REPO_ROOT, 'system', 'scripts', 'lib', 'token-budget.json');
const BASELINE_PATH = join(REPO_ROOT, 'system', 'scripts', 'lib', 'token-baselines.json');

function loadBudget() {
  const raw = readFileSync(BUDGET_PATH, 'utf8');
  return JSON.parse(raw);
}

function readSafe(absPath) {
  try {
    return readFileSync(absPath, 'utf8');
  } catch {
    return null;
  }
}

function measureFile(relPath) {
  const abs = join(REPO_ROOT, relPath);
  const text = readSafe(abs);
  if (text === null) return { path: relPath, exists: false, bytes: 0, lines: 0, tokens: 0 };
  const m = measure(text);
  return { path: relPath, exists: true, ...m };
}

async function expandTier2Globs(globs) {
  const paths = new Set();
  for (const pattern of globs) {
    if (pattern.includes('*')) {
      const root = REPO_ROOT;
      for await (const entry of glob(pattern, { cwd: root })) {
        paths.add(entry);
      }
    } else {
      paths.add(pattern);
    }
  }
  return [...paths].sort();
}

function validateCacheOrder(tier1Files, stabilityOrder) {
  // Walk the declared tier1 list. Once we see "slow", a later "frozen" is a violation.
  // Once we see "volatile", a later "slow" or "frozen" is a violation.
  const rank = Object.fromEntries(stabilityOrder.map((s, i) => [s, i]));
  const violations = [];
  let maxSeen = -1;
  for (const entry of tier1Files) {
    const r = rank[entry.stability ?? 'slow'];
    if (r === undefined) {
      violations.push(`unknown stability '${entry.stability}' on ${entry.path}`);
      continue;
    }
    if (r < maxSeen) {
      violations.push(
        `cache-pessimal ordering: ${entry.path} (${entry.stability}) appears after a more-volatile file`,
      );
    }
    if (r > maxSeen) maxSeen = r;
  }
  return violations;
}

function snapshotTier1(budget, host) {
  const files = [];
  for (const entry of budget.tier1_files) {
    const m = measureFile(entry.path);
    const overCap =
      entry.max_lines !== undefined && m.exists && m.lines > entry.max_lines ? entry.max_lines : null;
    files.push({
      path: entry.path,
      stability: entry.stability,
      exists: m.exists,
      required: entry.required === true,
      optional_existence: entry.optional_existence === true,
      bytes: m.bytes,
      lines: m.lines,
      tokens: m.tokens,
      max_lines: entry.max_lines ?? null,
      over_cap_at: overCap,
    });
  }

  if (host && budget.host_pointers?.[host]) {
    for (const ptr of budget.host_pointers[host]) {
      const m = measureFile(ptr);
      files.unshift({
        path: ptr,
        stability: 'frozen',
        exists: m.exists,
        required: true,
        optional_existence: false,
        bytes: m.bytes,
        lines: m.lines,
        tokens: m.tokens,
        max_lines: null,
        over_cap_at: null,
        host_pointer_for: host,
      });
    }
  }

  const totalBytes = files.reduce((s, f) => s + f.bytes, 0);
  const totalLines = files.reduce((s, f) => s + f.lines, 0);
  const totalTokens = estimateTokens(totalBytes);

  // Cache-stable prefix: bytes up to (but excluding) the first volatile file.
  let stableBytes = 0;
  for (const f of files) {
    if (f.stability === 'volatile') break;
    stableBytes += f.bytes;
  }

  return {
    files,
    total_bytes: totalBytes,
    total_lines: totalLines,
    total_tokens: totalTokens,
    cache_stable_bytes: stableBytes,
    cache_stable_tokens: estimateTokens(stableBytes),
    budget: {
      max_lines: budget.tier1_max_lines,
      max_tokens: budget.tier1_max_tokens,
    },
    cache_order_violations: validateCacheOrder(budget.tier1_files, budget.stability_order),
  };
}

async function snapshotTier2(budget) {
  const paths = await expandTier2Globs(budget.tier2_globs);
  const files = paths.map((p) => {
    const m = measureFile(p);
    return {
      path: p,
      bytes: m.bytes,
      lines: m.lines,
      tokens: m.tokens,
      over_cap_at: m.tokens > budget.per_protocol_max_tokens ? budget.per_protocol_max_tokens : null,
    };
  });
  files.sort((a, b) => b.tokens - a.tokens);
  return {
    files,
    total_bytes: files.reduce((s, f) => s + f.bytes, 0),
    total_tokens: files.reduce((s, f) => s + f.tokens, 0),
    top_5: files.slice(0, 5).map((f) => ({ path: f.path, tokens: f.tokens })),
  };
}

function findFailures(snap, budget) {
  const failures = [];
  // Required-file existence
  for (const f of snap.tier1.files) {
    if (f.required && !f.exists) {
      failures.push(`MISSING_REQUIRED: ${f.path} is declared required but does not exist`);
    }
    if (!f.required && !f.optional_existence && !f.exists) {
      failures.push(`MISSING: ${f.path} (declare optional_existence:true if intentional)`);
    }
  }
  // Per-file caps
  for (const f of snap.tier1.files) {
    if (f.over_cap_at !== null) {
      failures.push(`CAP_EXCEEDED: ${f.path} has ${f.lines} lines (cap ${f.over_cap_at})`);
    }
  }
  // Tier 1 totals
  if (snap.tier1.total_lines > budget.tier1_max_lines) {
    failures.push(
      `TIER1_LINES: ${snap.tier1.total_lines} lines exceeds budget ${budget.tier1_max_lines}`,
    );
  }
  if (snap.tier1.total_tokens > budget.tier1_max_tokens) {
    failures.push(
      `TIER1_TOKENS: ${snap.tier1.total_tokens} tokens exceeds budget ${budget.tier1_max_tokens}`,
    );
  }
  // Cache ordering
  for (const v of snap.tier1.cache_order_violations) {
    failures.push(`CACHE_ORDER: ${v}`);
  }
  // Per-protocol caps
  for (const f of snap.tier2.files) {
    if (f.over_cap_at !== null) {
      failures.push(
        `PROTOCOL_CAP: ${f.path} has ${f.tokens} tokens (cap ${budget.per_protocol_max_tokens})`,
      );
    }
  }
  return failures;
}

async function takeSnapshot({ host = null } = {}) {
  const budget = loadBudget();
  const tier1 = snapshotTier1(budget, host);
  const tier2 = await snapshotTier2(budget);
  const snap = {
    snapshot_at: new Date().toISOString(),
    enforce_caps: budget.enforce_caps === true,
    host: host ?? null,
    tier1,
    tier2,
  };
  snap.failures = findFailures(snap, budget);
  return snap;
}

function pad(s, n) {
  s = String(s);
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

function rpad(s, n) {
  s = String(s);
  return s.length >= n ? s : ' '.repeat(n - s.length) + s;
}

function fmtTier1(snap) {
  const lines = [];
  lines.push(
    `Tier 1 — always-on (budget: ${snap.tier1.budget.max_tokens} tokens / ${snap.tier1.budget.max_lines} lines)`,
  );
  for (const f of snap.tier1.files) {
    const exists = f.exists ? '' : '  [missing]';
    const cap = f.over_cap_at !== null ? `  ✗ over cap ${f.over_cap_at}` : '';
    const stab = f.stability ? `[${f.stability}]` : '';
    lines.push(
      `  ${pad(f.path, 64)} ${pad(stab, 10)} ${rpad(f.lines, 5)} lines  ${rpad(f.bytes, 7)} bytes  ${rpad(f.tokens, 6)} tokens${exists}${cap}`,
    );
  }
  const totalOK =
    snap.tier1.total_lines <= snap.tier1.budget.max_lines &&
    snap.tier1.total_tokens <= snap.tier1.budget.max_tokens
      ? '✓ within budget'
      : '✗ over budget';
  lines.push(
    `  ${pad('TOTAL', 64)} ${pad('', 10)} ${rpad(snap.tier1.total_lines, 5)} lines  ${rpad(snap.tier1.total_bytes, 7)} bytes  ${rpad(snap.tier1.total_tokens, 6)} tokens   ${totalOK}`,
  );
  lines.push('');
  lines.push(
    `Cache-stable prefix: ${snap.tier1.cache_stable_bytes} bytes / ${snap.tier1.cache_stable_tokens} tokens`,
  );
  if (snap.tier1.cache_order_violations.length > 0) {
    lines.push('Cache-order violations:');
    for (const v of snap.tier1.cache_order_violations) lines.push(`  ✗ ${v}`);
  }
  return lines.join('\n');
}

function fmtTier2(snap) {
  const lines = [];
  lines.push(`Tier 2 — on-demand (per-protocol cap: tokens-only)`);
  for (const f of snap.tier2.files) {
    const cap = f.over_cap_at !== null ? `  ✗ over cap ${f.over_cap_at}` : '';
    lines.push(
      `  ${pad(f.path, 56)} ${rpad(f.lines, 5)} lines  ${rpad(f.bytes, 7)} bytes  ${rpad(f.tokens, 6)} tokens${cap}`,
    );
  }
  lines.push('');
  lines.push(
    `Top 5 by tokens: ${snap.tier2.top_5.map((f) => `${f.path} (${f.tokens})`).join(', ')}`,
  );
  return lines.join('\n');
}

function fmtFailures(snap) {
  if (snap.failures.length === 0) return '';
  const lines = ['', 'Failures:'];
  for (const f of snap.failures) lines.push(`  ✗ ${f}`);
  return lines.join('\n');
}

function readBaseline() {
  if (!existsSync(BASELINE_PATH)) return null;
  try {
    return JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
  } catch {
    return null;
  }
}

function writeBaseline(snap) {
  writeFileSync(BASELINE_PATH, JSON.stringify(snap, null, 2) + '\n');
}

function snapshotAtRef(ref) {
  // Run *this script* at the given git ref by piping its stdout. Self-contained:
  // no external snapshot file required for a PR diff.
  const cwd = REPO_ROOT;
  const out = execFileSync(
    'git',
    [
      '-c',
      'advice.detachedHead=false',
      'show',
      `${ref}:system/scripts/measure-tokens.js`,
    ],
    { cwd, encoding: 'utf8' },
  );
  // Write to a temp file and run it. Simpler than evaluating in-process.
  const tmp = join(REPO_ROOT, `.measure-tokens.${ref.replace(/[^a-z0-9]/gi, '_')}.tmp.js`);
  writeFileSync(tmp, out);
  try {
    const json = execFileSync('node', [tmp, '--json'], { cwd, encoding: 'utf8' });
    return JSON.parse(json);
  } finally {
    try {
      writeFileSync(tmp, ''); // best effort wipe
    } catch {}
    try {
      execFileSync('rm', ['-f', tmp]);
    } catch {}
  }
}

function diff(current, baseline) {
  const lines = [];
  const beforeT1 = baseline?.tier1?.total_tokens ?? 0;
  const afterT1 = current.tier1.total_tokens;
  const delta = afterT1 - beforeT1;
  const pct = beforeT1 === 0 ? 0 : Math.round((delta / beforeT1) * -100 * 10) / 10;
  lines.push(`Tier 1 change: ${beforeT1} → ${afterT1} tokens (${delta >= 0 ? '+' : ''}${delta}, ${pct >= 0 ? '-' : '+'}${Math.abs(pct)}%)`);

  const beforeMap = new Map((baseline?.tier1?.files ?? []).map((f) => [f.path, f]));
  const afterMap = new Map(current.tier1.files.map((f) => [f.path, f]));
  const allPaths = new Set([...beforeMap.keys(), ...afterMap.keys()]);
  for (const p of allPaths) {
    const b = beforeMap.get(p);
    const a = afterMap.get(p);
    if (!b) lines.push(`  ${pad(p, 56)}  (added)        →  ${a.tokens} tokens`);
    else if (!a) lines.push(`  ${pad(p, 56)}  ${b.tokens} tokens  →  (removed)`);
    else if (a.tokens !== b.tokens) {
      const d = a.tokens - b.tokens;
      lines.push(`  ${pad(p, 56)}  ${b.tokens} → ${a.tokens} tokens (${d >= 0 ? '+' : ''}${d})`);
    }
  }
  return lines.join('\n');
}

function parseArgs(argv) {
  const args = {
    json: false,
    check: false,
    diff: false,
    diffAgainst: null,
    updateBaseline: false,
    host: null,
  };
  for (const a of argv.slice(2)) {
    if (a === '--json') args.json = true;
    else if (a === '--check') args.check = true;
    else if (a === '--diff') args.diff = true;
    else if (a.startsWith('--diff-against=')) {
      args.diff = true;
      args.diffAgainst = a.slice('--diff-against='.length);
    } else if (a === '--update-baseline') args.updateBaseline = true;
    else if (a.startsWith('--host=')) args.host = a.slice('--host='.length);
    else if (a === '--help' || a === '-h') {
      console.log(
        'Usage: measure-tokens.js [--json] [--check] [--diff] [--diff-against=<ref>] [--update-baseline] [--host=<name>]',
      );
      process.exit(0);
    } else {
      console.error(`unknown arg: ${a}`);
      process.exit(2);
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  const snap = await takeSnapshot({ host: args.host });

  if (args.updateBaseline) {
    writeBaseline(snap);
    console.error(`Baseline written to ${BASELINE_PATH}`);
  }

  if (args.json) {
    process.stdout.write(JSON.stringify(snap, null, 2) + '\n');
  } else {
    console.log(fmtTier1(snap));
    console.log('');
    console.log(fmtTier2(snap));
    console.log(fmtFailures(snap));
  }

  if (args.diff) {
    const baseline = args.diffAgainst ? snapshotAtRef(args.diffAgainst) : readBaseline();
    if (baseline === null) {
      console.error('No baseline found. Run with --update-baseline to create one, or pass --diff-against=<ref>.');
    } else {
      console.log('');
      console.log(diff(snap, baseline));
    }
  }

  if (args.check) {
    const budget = loadBudget();
    if (!budget.enforce_caps) {
      console.error('(observe-only mode — enforce_caps:false in token-budget.json)');
      process.exit(0);
    }
    if (snap.failures.length > 0) {
      console.error(`Token budget check FAILED (${snap.failures.length} issues)`);
      process.exit(1);
    }
    console.error('Token budget check passed');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
