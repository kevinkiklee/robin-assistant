// Omnibus --help snapshot test (Phase B.1 Task 5).
//
// Spawns `node robin <argv...> --help` for every entry in COMMAND_REGISTRY
// (skipping the SKIP list of obsolete / non-dispatchable entries and the
// DB-dependent commands whose --help path would require a live daemon).
//
// Three assertions:
//   1. --help exits 0.
//   2. --help output includes the command's registry summary (or registry
//      `help` text from commands.js — both are emitted by the centralized
//      help-formatter in dispatchFor).
//   3. For commands with siblings, --help output contains "Related:".
//
// Tests are gated behind ROBIN_SKIP_SLOW because each spawn costs ~150ms.

import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import test from 'node:test';
import { argvFor, COMMAND_REGISTRY, relatedFor } from '../../runtime/cli/command-registry.js';

const SKIP_SLOW = process.env.ROBIN_SKIP_SLOW === '1';

// Commands skipped because their registry name maps to a non-dispatchable
// argv (obsolete entries or pure CLI flags) — argvFor returns null.
// Also: the `help` registry entry is the top-level `robin --help`; that's
// covered by a dedicated test (cli-help.test.js) and doesn't need a per-leaf
// snapshot.
const SKIPPED_NAMES = new Set([
  'version', // handled by `robin --version` flag, not a subcommand
  'surreal-install', // obsolete registry entry — not in commands.js
  'surreal-ensure-running', // obsolete registry entry — not in commands.js
  'brief-gallery', // not currently wired in commands.js
  'mcp-ensure-running', // not currently wired in commands.js
  'help', // top-level --help, covered by cli-help.test.js
]);

function runHelp(argv) {
  const robin = resolve(process.cwd(), 'system/bin/robin');
  const env = {
    ...process.env,
    ROBIN_SKIP_FIRST_RUN: '1', // skip the auto-install path; --help is read-only
  };
  const r = spawnSync('node', [robin, ...argv, '--help'], {
    encoding: 'utf8',
    timeout: 10000,
    env,
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function targets() {
  const out = [];
  for (const entry of COMMAND_REGISTRY) {
    if (SKIPPED_NAMES.has(entry.name)) continue;
    const argv = argvFor(entry.name);
    if (!argv) continue;
    out.push({ entry, argv });
  }
  return out;
}

test('every registered command responds to --help with exit 0', { skip: SKIP_SLOW }, () => {
  const failures = [];
  for (const { entry, argv } of targets()) {
    const r = runHelp(argv);
    if (r.status !== 0) {
      failures.push(
        `${entry.name} (argv=${JSON.stringify(argv)}): exit=${r.status} stderr=${r.stderr.slice(0, 120)}`,
      );
    }
  }
  assert.deepStrictEqual(failures, [], `commands failing --help:\n${failures.join('\n')}`);
});

test('every registered command --help includes its summary', { skip: SKIP_SLOW }, () => {
  const failures = [];
  for (const { entry, argv } of targets()) {
    const r = runHelp(argv);
    if (r.status !== 0) continue; // counted in the previous test
    const out = r.stdout + r.stderr;
    if (!out.includes(entry.summary)) {
      failures.push(`${entry.name}: --help output missing summary "${entry.summary}"`);
    }
  }
  assert.deepStrictEqual(
    failures,
    [],
    `commands missing summary in --help:\n${failures.join('\n')}`,
  );
});

test('commands with siblings show Related: in --help (≥30 expected)', { skip: SKIP_SLOW }, () => {
  const failures = [];
  let withSiblings = 0;
  let withRelated = 0;
  for (const { entry, argv } of targets()) {
    const siblings = relatedFor(entry.name);
    if (siblings.length === 0) continue;
    withSiblings += 1;
    const r = runHelp(argv);
    if (r.status !== 0) continue;
    const out = r.stdout + r.stderr;
    if (/Related:/.test(out)) {
      withRelated += 1;
    } else {
      failures.push(
        `${entry.name}: --help output missing "Related:" section (has ${siblings.length} siblings)`,
      );
    }
  }
  // Threshold check: at least 30 commands with siblings must show Related:.
  // Surface the work-list when below threshold so follow-up sweeps know what
  // to fix.
  if (withRelated < 30) {
    assert.fail(
      `expected ≥30 commands with Related: footer, got ${withRelated}/${withSiblings}\n${failures.join('\n')}`,
    );
  }
});
