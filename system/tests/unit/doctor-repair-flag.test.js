// `robin doctor --repair=<name> [--apply]` runs one invariant's repair()
// function. The flag was referenced in three invariants' remediation strings
// but silently ignored by the dispatcher until the dispatcher wired it up.
//
// This file exercises the dispatcher path: known invariant + repair available,
// unknown name, check-only invariant (no repair), dry-run vs apply.

import assert from 'node:assert';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { doctor } from '../../runtime/cli/commands/doctor.js';

// doctor() resolves ROBIN_HOME on each call; without it, --repair=... throws
// "Robin is not installed" before the dispatcher even sees the flag. Seeding a
// tmp ROBIN_HOME at module load gives every test a fresh, valid install
// pointer without making each test do its own setup.
const __testHome = join(
  tmpdir(),
  `robin-test-doctor-${process.pid}-${Math.random().toString(36).slice(2)}`,
);
mkdirSync(join(__testHome, 'runtime'), { recursive: true });
mkdirSync(join(__testHome, 'config'), { recursive: true });
writeFileSync(
  join(__testHome, 'config', 'config.json'),
  JSON.stringify({ embedder_profile: 'mxbai-1024' }),
);
process.env.ROBIN_HOME = __testHome;

function captureOut() {
  const lines = [];
  return { out: (s) => lines.push(s), lines };
}

test('--repair=<unknown> prints error and lists available invariants', async () => {
  const { out, lines } = captureOut();
  await doctor(['--repair=does.not.exist'], { out, err: () => {} });
  const joined = lines.join('\n');
  assert.match(joined, /unknown invariant: does\.not\.exist/);
  assert.match(joined, /available:/);
  // Sanity: at least one real invariant name appears in the available list.
  assert.match(joined, /install\.pointer_present/);
});

test('--repair=<check-only-invariant> reports no repair defined', async () => {
  // db.embedder_profile_match has check() but no repair() — confirmed by
  // reading the file at audit time.
  const { out, lines } = captureOut();
  await doctor(['--repair=db.embedder_profile_match'], { out, err: () => {} });
  const joined = lines.join('\n');
  assert.match(joined, /no repair\(\) defined/);
});

test('--repair=runtime.no_orphan_node_test_procs without --apply runs dry-run', async () => {
  const { out, lines } = captureOut();
  await doctor(['--repair=runtime.no_orphan_node_test_procs'], { out, err: () => {} });
  const joined = lines.join('\n');
  assert.match(joined, /\(dry-run\)/);
  // Either nothing_to_clean (clean environment) or would_kill_and_clean (stale
  // procs present) — both are valid dry-run outcomes.
  assert.match(joined, /repair: /);
  if (/would_kill_and_clean/.test(joined)) {
    assert.match(joined, /re-run with --apply to commit/);
  }
});

test('--repair=<name> --apply runs in apply mode', async () => {
  const { out, lines } = captureOut();
  await doctor(['--repair=runtime.no_orphan_node_test_procs', '--apply'], {
    out,
    err: () => {},
  });
  const joined = lines.join('\n');
  assert.match(joined, /\(apply\)/);
  // Should NOT emit the dry-run hint.
  assert.doesNotMatch(joined, /re-run with --apply/);
});

test('bare --repair (no value) does not trigger repair dispatch', async () => {
  // parseArgs gives `flags.repair === true` (no value). The dispatcher
  // guard checks for a non-empty string, so this falls through to the
  // default status path rather than crashing.
  const { out, lines } = captureOut();
  // We can't easily run the full default path in a unit test (it reads many
  // filesystem things), so just verify it doesn't take the repair branch:
  // a `--repair` true value would crash without a name.
  let crashed = false;
  try {
    await doctor(['--repair', '--apply'], { out, err: () => {} });
  } catch {
    crashed = true;
  }
  // Either it crashes inside the default doStatus path (which is fine — we
  // only care that it didn't dispatch to repair with name=undefined), or it
  // completes; what it must NOT do is emit `unknown invariant: true`.
  const joined = lines.join('\n');
  assert.doesNotMatch(joined, /unknown invariant: true/);
  void crashed;
});
