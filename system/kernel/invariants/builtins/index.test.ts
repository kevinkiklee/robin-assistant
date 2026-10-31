import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { closeDb, openDb } from '../../../brain/memory/db.ts';
import { allMigrations, applyMigrations } from '../../../brain/memory/migrations/index.ts';
import { buildDoctorInvariants } from '../doctor-set.ts';
import { runInvariants } from '../runner.ts';
import {
  daemonHeartbeatingInvariant,
  dbReachableInvariant,
  dbSchemaCurrentInvariant,
  dbWalSizeBoundedInvariant,
  userDataWritableInvariant,
} from './index.ts';

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'robin-inv-'));
  mkdirSync(join(dir, 'state', 'db'), { recursive: true });
  const db = openDb(join(dir, 'state', 'db', 'robin.sqlite'));
  applyMigrations(db, allMigrations);
  return { db, dir };
}

test('builtin invariants: all pass on a fresh, healthy state', async () => {
  const { db, dir } = freshDb();
  const reports = await runInvariants([
    userDataWritableInvariant(dir),
    dbReachableInvariant(db),
    dbSchemaCurrentInvariant(db),
    dbWalSizeBoundedInvariant(db),
    daemonHeartbeatingInvariant({ lastTickAt: () => new Date(), maxIntervalMs: 60_000 }),
  ]);
  const failures = reports.filter((r) => !r.ok);
  assert.deepEqual(failures, [], `expected no failures, got ${JSON.stringify(failures)}`);
  closeDb(db);
});

test('daemon.heartbeating: fails when no tick has been recorded', async () => {
  const reports = await runInvariants([
    daemonHeartbeatingInvariant({ lastTickAt: () => null, maxIntervalMs: 1000 }),
  ]);
  assert.equal(reports[0].ok, false);
});

test('install.user_data_writable: fails on a non-existent path', async () => {
  const reports = await runInvariants([userDataWritableInvariant('/nonexistent/robin/path')]);
  assert.equal(reports[0].ok, false);
});

// ── doctor-set default repoRoot: never process.cwd() ────────────────────────
//
// The daemon's launchd WorkingDirectory is user-data/, and doctor.run (jobs.ts)
// calls `buildDoctorInvariants(db, userData)` with no repoRoot override. A
// cwd-derived default there silently points every repoRoot-based invariant
// (mcp.dist_current, agent.worktrees_bounded) at user-data/ — which has
// neither dist/ nor .worktrees/ — so both checks read "nothing found" as "all
// clear" forever (Task 3 review finding, Critical). This exercises the fix
// THROUGH buildDoctorInvariants with process.cwd() pointed somewhere foreign.
//
// mcp.dist_current can't prove the fix through its own ok/fail here: CI never
// runs `pnpm build` before `pnpm test` (see .github/workflows/tests.yml), so
// LOADED_SHA is null in every test process, and the invariant's `check()`
// short-circuits to `{ ok: true }` whenever `loadedSha()` is null — a result
// that's identical whether repoRoot resolved correctly or not. That gate is
// already covered directly, with an injected loadedSha, in dist-current.test.ts.
// agent.worktrees_bounded has no such gate and is built from the exact same
// `repoRoot` local variable in buildDoctorInvariants, so it's the deterministic
// proxy that proves the shared root cause is fixed for both invariants.
test('buildDoctorInvariants: default repoRoot anchors to the package location, not process.cwd()', async () => {
  // This test file lives one directory deeper (builtins/) than doctor-set.ts,
  // hence one extra '..' versus doctor-set.ts's own defaultRepoRoot().
  const realRepoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
  const worktreesDir = join(realRepoRoot, '.worktrees');
  const existedBefore = existsSync(worktreesDir);
  const markerPrefix = `robin-doctor-set-test-${Date.now()}-`;
  // 6 planted dirs always exceed the default warnCount (5), regardless of how
  // many real agent worktrees happen to already be pending review.
  const markers = Array.from({ length: 6 }, (_, i) => join(worktreesDir, `${markerPrefix}${i}`));
  for (const m of markers) mkdirSync(m, { recursive: true });

  const { db, dir } = freshDb();
  const foreignCwd = mkdtempSync(join(tmpdir(), 'robin-doctor-cwd-'));
  const prevCwd = process.cwd();
  process.chdir(foreignCwd);
  try {
    const invariants = buildDoctorInvariants(db, dir); // deliberately NO repoRoot argument
    const distCurrent = invariants.find((i) => i.name === 'mcp.dist_current');
    const worktrees = invariants.find((i) => i.name === 'agent.worktrees_bounded');
    assert.ok(distCurrent, 'mcp.dist_current must be registered by buildDoctorInvariants');
    assert.ok(worktrees, 'agent.worktrees_bounded must be registered by buildDoctorInvariants');

    // Sanity: wired correctly and never throws, even with a foreign cwd that has no dist/.
    const distReport = await distCurrent?.check();
    assert.equal(distReport?.ok, true, JSON.stringify(distReport));

    // Load-bearing assertion: the 6 planted dirs under the REAL repo's
    // .worktrees/ must be visible even though process.cwd() is foreignCwd. A
    // cwd-derived repoRoot would look under `${foreignCwd}/.worktrees`
    // (doesn't exist) and report ok, silently missing the planted markers —
    // exactly the bug this test guards against.
    const wtReport = await worktrees?.check();
    assert.equal(wtReport?.ok, false, JSON.stringify(wtReport));
    assert.match(wtReport?.message ?? '', /agent worktrees/);
  } finally {
    process.chdir(prevCwd);
    for (const m of markers) rmSync(m, { recursive: true, force: true });
    if (!existedBefore) rmSync(worktreesDir, { recursive: true, force: true });
  }
});

test('daemon.heartbeating: silence is measured from a host wake, not from before the nap', async () => {
  const now = Date.now();
  const lastTickAt = () => new Date(now - 16 * 60_000); // last tick before a 16-min nap
  const asleep = daemonHeartbeatingInvariant({ lastTickAt, maxIntervalMs: 7 * 60_000 });
  assert.equal((await asleep.check()).ok, false, 'no wake info → old behaviour');

  const justWoke = daemonHeartbeatingInvariant({
    lastTickAt,
    maxIntervalMs: 7 * 60_000,
    lastWakeAt: () => now - 30_000,
  });
  assert.equal((await justWoke.check()).ok, true, 'woke 30 s ago — scheduler still has time');

  const wedgedAfterWake = daemonHeartbeatingInvariant({
    lastTickAt,
    maxIntervalMs: 7 * 60_000,
    lastWakeAt: () => now - 8 * 60_000,
  });
  const r = await wedgedAfterWake.check();
  assert.equal(r.ok, false, 'awake 8 min with no tick is a real wedge');
  assert.match(r.message ?? '', /since host wake/);
});
