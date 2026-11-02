import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Invariant } from '../../kernel/invariants/types.ts';
import {
  getOpenAlert,
  listAlerts,
  markRepairAttempted,
  recordAlert,
} from '../../kernel/runtime/alert-store.ts';
import { currentSha, recordRepairFailure } from '../../kernel/runtime/repair-breaker.ts';
import { closeDb, openDb } from '../memory/db.ts';
import { allMigrations, applyMigrations } from '../memory/migrations/index.ts';
import { COGNITION_JOBS, registerCognitionJobs, runDoctorInvariants } from './jobs.ts';

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'robin-cog-jobs-'));
  mkdirSync(join(dir, 'state', 'db'), { recursive: true });
  const db = openDb(join(dir, 'state', 'db', 'robin.sqlite'));
  applyMigrations(db, allMigrations);
  return db;
}

/** Same as freshDb, but also returns the tmp dir as `userData` — runDoctorInvariants
 *  needs a real directory to read/write repair-breaker.json against. */
function freshDbWithUserData() {
  const dir = mkdtempSync(join(tmpdir(), 'robin-cog-jobs-doctor-'));
  mkdirSync(join(dir, 'state', 'db'), { recursive: true });
  const db = openDb(join(dir, 'state', 'db', 'robin.sqlite'));
  applyMigrations(db, allMigrations);
  return { db, userData: dir };
}

/** A controllable invariant for the doctor-wiring tests below — mirrors the
 *  fakeInvariant helper in health-monitor.test.ts. */
function fakeInvariant(
  name: string,
  check: () => { ok: boolean; message?: string },
  opts: { repair?: () => void; severity?: Invariant['severity'] } = {},
): Invariant {
  return {
    name,
    severity: opts.severity ?? 'warning',
    symptom: `${name}: symptom placeholder`,
    cause: 'test',
    fix: 'test',
    check,
    ...(opts.repair ? { repair: opts.repair } : {}),
  };
}

test('cognition jobs: COGNITION_JOBS lists biographer + dream + automatic doc ingest', () => {
  const names = COGNITION_JOBS.map((j) => j.name);
  assert.ok(names.includes('biographer.run'));
  assert.ok(names.includes('dream.run'));
  // ingest-docs runs on a cron so the user never has to invoke it by hand.
  assert.ok(names.includes('ingest-docs.run'));
  assert.ok(names.includes('retention.run'), 'daily file-retention sweep is registered');
});

test('cognition jobs: reliability-audit.run is registered at 4:00am with a handler', () => {
  const byName = new Map(COGNITION_JOBS.map((j) => [j.name, j.cron]));
  assert.equal(byName.get('reliability-audit.run'), '0 4 * * *');

  const db = freshDb();
  const handlers: string[] = [];
  const fakeDaemon = {
    registerHandler: (name: string) => {
      handlers.push(name);
    },
  } as unknown as Parameters<typeof registerCognitionJobs>[0];
  registerCognitionJobs(fakeDaemon, db, () => null);
  assert.ok(handlers.includes('reliability-audit.run'));
  closeDb(db);
});

test('cognition jobs: retention.run prunes stale terminal job rows every day, not only past the ceiling', async () => {
  // Regression (2026-10-16): the prune lived only in jobs.history_bounded's repair(),
  // which the doctor runs only once the 50k ceiling trips — so rows grew ~13 days
  // between prunes. A table far BELOW the ceiling must still lose its stale rows.
  const { db, userData } = freshDbWithUserData();
  const prevUserData = process.env.ROBIN_USER_DATA_DIR;
  process.env.ROBIN_USER_DATA_DIR = userData;
  try {
    const seed = (age: string, state: string) =>
      db
        .prepare(
          `INSERT INTO jobs (name, trigger_kind, scheduled_at, state, created_at)
           VALUES ('x.tick','cron','x',?,datetime('now',?))`,
        )
        .run(state, age);
    seed('-10 days', 'completed');
    seed('-10 days', 'errored');
    seed('-1 day', 'completed');
    seed('-10 days', 'pending');

    const handlers = new Map<string, () => unknown>();
    const fakeDaemon = {
      registerHandler: (name: string, fn: () => unknown) => handlers.set(name, fn),
    } as unknown as Parameters<typeof registerCognitionJobs>[0];
    registerCognitionJobs(fakeDaemon, db, () => null);
    await handlers.get('retention.run')?.();

    const rows = db
      .prepare(
        `SELECT state, created_at > datetime('now','-7 days') AS recent FROM jobs
          WHERE name = 'x.tick' ORDER BY state, recent`,
      )
      .all() as Array<{ state: string; recent: number }>;
    assert.deepEqual(
      rows.map((r) => `${r.state}:${r.recent ? 'recent' : 'stale'}`),
      ['completed:recent', 'pending:stale'],
      'stale terminal rows pruned; recent terminal + non-terminal rows kept',
    );
  } finally {
    if (prevUserData === undefined) delete process.env.ROBIN_USER_DATA_DIR;
    else process.env.ROBIN_USER_DATA_DIR = prevUserData;
    closeDb(db);
  }
});

test('cognition jobs: registerCognitionJobs seeds cron rows for each', () => {
  const db = freshDb();
  const fakeDaemon = { registerHandler: () => {} } as unknown as Parameters<
    typeof registerCognitionJobs
  >[0];
  registerCognitionJobs(fakeDaemon, db, () => null);
  const rows = db.prepare("SELECT name FROM jobs WHERE state='pending'").all() as Array<{
    name: string;
  }>;
  const names = rows.map((r) => r.name);
  assert.ok(names.includes('biographer.run'));
  assert.ok(names.includes('dream.run'));
  closeDb(db);
});

test('cognition jobs: five weekly domain-scout crons, staggered off the nightly stack', () => {
  const byName = new Map(COGNITION_JOBS.map((j) => [j.name, j.cron]));
  // Mon finance, Tue travel, Wed health, Thu career, Fri social — all 5:30am,
  // clear of the 3:40–5:00 nightly stack.
  assert.equal(byName.get('scout-finance.run'), '30 5 * * 1');
  assert.equal(byName.get('scout-travel.run'), '30 5 * * 2');
  assert.equal(byName.get('scout-health.run'), '30 5 * * 3');
  assert.equal(byName.get('scout-career.run'), '30 5 * * 4');
  assert.equal(byName.get('scout-social.run'), '30 5 * * 5');
});

test('cognition jobs: registerCognitionJobs registers a handler per scout job', () => {
  const db = freshDb();
  const handlers: string[] = [];
  const fakeDaemon = {
    registerHandler: (name: string) => {
      handlers.push(name);
    },
  } as unknown as Parameters<typeof registerCognitionJobs>[0];
  registerCognitionJobs(fakeDaemon, db, () => null);
  for (const id of ['finance', 'travel', 'health', 'career', 'social']) {
    assert.ok(handlers.includes(`scout-${id}.run`), `scout-${id}.run handler registered`);
  }
  closeDb(db);
});

test('cognition jobs: getDomainGating resolver is accepted as 5th parameter', () => {
  // registerCognitionJobs must accept a getDomainGating resolver as its 5th parameter,
  // mirroring how getDraftClaims is the 4th. The resolver is lazy — only called inside
  // the biographer.run handler, not at registration time.
  const db = freshDb();
  const fakeDaemon = { registerHandler: () => {} } as unknown as Parameters<
    typeof registerCognitionJobs
  >[0];

  let resolverCallCount = 0;
  const getDomainGating = () => {
    resolverCallCount++;
    return false;
  };

  // Must not throw — 5 args is the new valid signature.
  registerCognitionJobs(
    fakeDaemon,
    db,
    () => null,
    () => true,
    getDomainGating,
  );

  // Resolver is lazy: not called during registration, only inside the handler.
  assert.equal(resolverCallCount, 0, 'resolver is lazy — not called during registration');

  closeDb(db);
});

test('cognition jobs: getDomainGating defaults to () => true when omitted', () => {
  const db = freshDb();
  // registerCognitionJobs must be callable with only 3 positional args and still
  // work — the default () => true kicks in for both getDraftClaims and getDomainGating.
  const fakeDaemon = { registerHandler: () => {} } as unknown as Parameters<
    typeof registerCognitionJobs
  >[0];
  // Should not throw even without the 4th/5th args.
  assert.doesNotThrow(() => registerCognitionJobs(fakeDaemon, db, () => null));
  closeDb(db);
});

// --- doctor.run's incident-ladder wiring (runDoctorInvariants) ---------------
// These exercise the exported helper directly with fake invariants rather
// than the real buildDoctorInvariants() set, the same injection strategy
// health-monitor.test.ts uses for its own alert-wiring tests (fs/db-backed
// real invariants can't be made to fail deterministically without a lot of
// environment scaffolding).

test('doctor wiring: first failing pass opens the alert, marks attempted, and runs repair', async () => {
  const { db, userData } = freshDbWithUserData();
  let repairCalls = 0;
  const inv = fakeInvariant(
    'test.doctor-stubborn',
    () => ({ ok: false, message: 'still broken' }),
    {
      repair: () => {
        repairCalls++; // never actually fixes the check — keeps the incident open
      },
    },
  );

  await runDoctorInvariants(db, userData, [inv]);

  assert.equal(repairCalls, 1, 'repair() ran on the first failing pass');
  const row = getOpenAlert(db, 'invariant', 'test.doctor-stubborn');
  assert.ok(row, 'a doctor-only invariant failing for the first time gets a real alert row');
  assert.ok(row?.repair_attempted_at, 'repair_attempted_at set on the first pass');
  closeDb(db);
});

test('doctor wiring: second pass on the same open incident skips repair (once-per-incident spans doctor runs)', async () => {
  const { db, userData } = freshDbWithUserData();
  let repairCalls = 0;
  const inv = fakeInvariant(
    'test.doctor-stubborn2',
    () => ({ ok: false, message: 'still broken' }),
    {
      repair: () => {
        repairCalls++;
      },
    },
  );

  await runDoctorInvariants(db, userData, [inv]); // pass 1
  assert.equal(repairCalls, 1);
  const attemptedAtPass1 = getOpenAlert(
    db,
    'invariant',
    'test.doctor-stubborn2',
  )?.repair_attempted_at;
  assert.ok(attemptedAtPass1);

  await runDoctorInvariants(db, userData, [inv]); // pass 2 — same still-open incident
  assert.equal(
    repairCalls,
    1,
    'repair() must not run again for an incident already marked attempted',
  );
  const row = getOpenAlert(db, 'invariant', 'test.doctor-stubborn2');
  assert.ok(row, 'incident stays open — still failing');
  assert.equal(row?.repair_attempted_at, attemptedAtPass1, 'attempted-mark unchanged from pass 1');
  closeDb(db);
});

test('doctor wiring: tripped repair breaker skips repair() but the attempted-mark still lands', async () => {
  const { db, userData } = freshDbWithUserData();
  const sha = currentSha();
  // TRIP_THRESHOLD is 2 consecutive failures on the current build sha.
  recordRepairFailure(userData, 'test.doctor-broken-breaker', sha);
  recordRepairFailure(userData, 'test.doctor-broken-breaker', sha);

  let repairCalls = 0;
  const inv = fakeInvariant(
    'test.doctor-broken-breaker',
    () => ({ ok: false, message: 'still broken' }),
    {
      repair: () => {
        repairCalls++;
      },
    },
  );

  await runDoctorInvariants(db, userData, [inv]);

  assert.equal(repairCalls, 0, 'repair() must not run once the circuit breaker is tripped');
  const row = getOpenAlert(db, 'invariant', 'test.doctor-broken-breaker');
  assert.ok(row, 'alert row still created for the doctor-only invariant');
  assert.ok(
    row?.repair_attempted_at,
    'attempted-mark still lands even with the breaker tripped, so escalation can proceed',
  );
  closeDb(db);
});

test('doctor wiring: an ok invariant with a prior attempted incident resolves and is credited repaired', async () => {
  const { db, userData } = freshDbWithUserData();
  // Simulate an incident already opened and attempted by an earlier pass
  // (could be a prior doctor.run, or — for an invariant the monitor also
  // checks — health-monitor's own tick).
  recordAlert(db, {
    severity: 'warning',
    source: 'invariant',
    key: 'test.doctor-recovered',
    message: 'was broken',
  });
  markRepairAttempted(db, 'invariant', 'test.doctor-recovered');

  const inv = fakeInvariant('test.doctor-recovered', () => ({ ok: true }));
  await runDoctorInvariants(db, userData, [inv]);

  assert.equal(
    getOpenAlert(db, 'invariant', 'test.doctor-recovered'),
    undefined,
    'incident resolved',
  );
  const rows = listAlerts(db, { all: true }).filter((r) => r.key === 'test.doctor-recovered');
  assert.equal(rows.length, 1);
  assert.ok(rows[0].resolved_at);
  assert.equal(
    rows[0].outcome,
    'repaired',
    'resolveAlert credits repaired automatically since repair_attempted_at was set',
  );
  closeDb(db);
});

test('doctor wiring: a failing invariant with no repair() still gets an alert row', async () => {
  // Mirrors mcp.dist_current / agent.worktrees_bounded — doctor-only
  // invariants that declare no repair() at all. beforeRepair is only ever
  // invoked when inv.repair is defined, so these depend entirely on the
  // after-the-run recordAlert pass for their first incident row.
  const { db, userData } = freshDbWithUserData();
  const inv = fakeInvariant('test.doctor-norepair', () => ({
    ok: false,
    message: 'no fix possible',
  }));

  await runDoctorInvariants(db, userData, [inv]);

  const row = getOpenAlert(db, 'invariant', 'test.doctor-norepair');
  assert.ok(row, 'alert row created even though the invariant declares no repair()');
  assert.equal(row?.repair_attempted_at, null, 'never attempted — nothing to repair');
  closeDb(db);
});
