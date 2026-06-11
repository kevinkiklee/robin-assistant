import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { closeDb, openDb, type RobinDb } from '../../brain/memory/db.ts';
import { allMigrations, applyMigrations } from '../../brain/memory/migrations/index.ts';
import type { Invariant } from '../invariants/types.ts';
import { HealthMonitor } from './health-monitor.ts';

// HealthMonitor.tick is private; cast through unknown for the regression tests.
type HealthMonitorInternals = { tick: () => Promise<void> };
function tickOnce(m: HealthMonitor): Promise<void> {
  return (m as unknown as HealthMonitorInternals).tick();
}

// buildInvariants is private; replace it per-instance so the alert-wiring,
// timeout, and overlap-guard tests can inject controlled invariants instead of
// the real db/fs-backed set.
function stubInvariants(m: HealthMonitor, invs: Invariant[]): void {
  (m as unknown as { buildInvariants: () => Invariant[] }).buildInvariants = () => invs;
}

/** A trivially-passing or trivially-failing invariant for alert-wiring tests. */
function fakeInvariant(
  name: string,
  result: { ok: boolean; message?: string },
  severity: Invariant['severity'] = 'warning',
): Invariant {
  return {
    name,
    severity,
    symptom: '',
    cause: '',
    fix: '',
    check: () => result,
  };
}

/** Count open (unresolved) alert rows for (source,key). */
function openAlert(db: RobinDb, source: string, key: string) {
  return db
    .prepare(`SELECT * FROM alerts WHERE source=? AND key=? AND resolved_at IS NULL`)
    .get(source, key) as { severity: string; message: string } | undefined;
}
function resolvedAlert(db: RobinDb, source: string, key: string) {
  return db
    .prepare(`SELECT * FROM alerts WHERE source=? AND key=? AND resolved_at IS NOT NULL`)
    .get(source, key) as { resolved_at: string } | undefined;
}

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'robin-hm-'));
  mkdirSync(join(dir, 'state', 'db'), { recursive: true });
  const db = openDb(join(dir, 'state', 'db', 'robin.sqlite'));
  applyMigrations(db, allMigrations);
  process.env.ROBIN_USER_DATA_DIR = dir;
  return db;
}

test('health-monitor: constructs without errors', () => {
  const db = freshDb();
  const m = new HealthMonitor({
    db,
    getLLM: () => null,
    getLastTickAt: () => new Date(),
  });
  m.start();
  m.stop();
  closeDb(db);
});

test('health-monitor: stop is idempotent', () => {
  const db = freshDb();
  const m = new HealthMonitor({
    db,
    getLLM: () => null,
    getLastTickAt: () => null,
  });
  m.stop();
  m.start();
  m.stop();
  m.stop();
  closeDb(db);
});

test('health-monitor: enableNotifications accepts a getter (re-evaluated per tick)', () => {
  const db = freshDb();
  let toggle = false;
  const m = new HealthMonitor({
    db,
    getLLM: () => null,
    getLastTickAt: () => new Date(),
    enableNotifications: () => toggle,
  });
  // Just construct + start + stop — actually firing notifications would invoke osascript.
  // The test here is that the option shape compiles and accepts a function. The wired-up
  // tick path is exercised by the daemon's end-to-end smoke test.
  m.start();
  toggle = true;
  m.stop();
  closeDb(db);
});

test('Bug A: heartbeat CRITICAL fires onHeartbeatCritical when sustained AND uptime >= min', async () => {
  const db = freshDb();
  const calls: number[] = [];
  // lastTickAt 45 min ago — exceeds both the 5-min heartbeat threshold AND the
  // 30-min sustained-CRITICAL threshold, so a single tick observation is enough
  // to satisfy both gates.
  const staleTick = new Date(Date.now() - 45 * 60_000);
  // Need to backdate first-observation too: tick() initializes
  // firstHeartbeatCriticalAt to now() on first CRITICAL, so a fresh monitor would
  // see sustainedMs=0 on the first call. Backdating mimics multiple prior ticks.
  // startedAt 60 min ago — exceeds the 2-min suppression window.
  const startedAt = Date.now() - 60 * 60_000;

  const m = new HealthMonitor({
    db,
    getLLM: () => null,
    getLastTickAt: () => staleTick,
    getStartedAt: () => startedAt,
    onHeartbeatCritical: () => calls.push(Date.now()),
  });

  // First tick records firstHeartbeatCriticalAt=now → sustainedMs=0 → defer.
  await tickOnce(m);
  assert.equal(calls.length, 0, 'first CRITICAL observation must defer (sustained=0)');

  // Force-advance the internal first-critical timestamp by 31 min so the next tick
  // sees sustainedMs >= 30 min. Field is private; reach in for the test.
  (m as unknown as { firstHeartbeatCriticalAt: number }).firstHeartbeatCriticalAt =
    Date.now() - 31 * 60_000;
  await tickOnce(m);
  assert.equal(calls.length, 1, 'second CRITICAL after sustained window must fire');

  // Subsequent ticks must not re-fire (once per daemon lifetime).
  await tickOnce(m);
  assert.equal(calls.length, 1, 'recovery must fire exactly once per lifetime');
  closeDb(db);
});

test('Bug A: heartbeat CRITICAL alone (not sustained) does NOT fire recovery', async () => {
  const db = freshDb();
  const calls: number[] = [];
  const staleTick = new Date(Date.now() - 10 * 60_000); // CRITICAL but only just
  const startedAt = Date.now() - 60 * 60_000;

  const m = new HealthMonitor({
    db,
    getLLM: () => null,
    getLastTickAt: () => staleTick,
    getStartedAt: () => startedAt,
    onHeartbeatCritical: () => calls.push(Date.now()),
  });

  // Single tick → firstHeartbeatCriticalAt=now → sustainedMs=0 → must defer.
  await tickOnce(m);
  assert.equal(calls.length, 0, 'unsustained CRITICAL must not loop-restart the daemon');
  closeDb(db);
});

test('Bug A: heartbeat recovers between CRITICALs → sustained counter resets', async () => {
  const db = freshDb();
  const calls: number[] = [];
  let stale = true;
  const startedAt = Date.now() - 60 * 60_000;

  const m = new HealthMonitor({
    db,
    getLLM: () => null,
    getLastTickAt: () => (stale ? new Date(Date.now() - 10 * 60_000) : new Date()),
    getStartedAt: () => startedAt,
    onHeartbeatCritical: () => calls.push(Date.now()),
  });

  // Tick 1 → CRITICAL → firstHeartbeatCriticalAt set
  await tickOnce(m);
  assert.equal(
    typeof (m as unknown as { firstHeartbeatCriticalAt: number | null }).firstHeartbeatCriticalAt,
    'number',
  );

  // Tick 2 → healthy → counter cleared
  stale = false;
  await tickOnce(m);
  assert.equal(
    (m as unknown as { firstHeartbeatCriticalAt: number | null }).firstHeartbeatCriticalAt,
    null,
    'sustained counter must reset on recovery',
  );

  // Tick 3 → CRITICAL again, fresh counter, no recovery fired
  stale = true;
  await tickOnce(m);
  assert.equal(calls.length, 0, 'fresh CRITICAL after recovery starts the counter over');
  closeDb(db);
});

test('Bug A: heartbeat CRITICAL during boot window suppresses onHeartbeatCritical', async () => {
  const db = freshDb();
  const calls: number[] = [];
  const staleTick = new Date(Date.now() - 10 * 60_000);
  // startedAt 30 sec ago — inside the 2-min suppression window.
  const startedAt = Date.now() - 30_000;

  const m = new HealthMonitor({
    db,
    getLLM: () => null,
    getLastTickAt: () => staleTick,
    getStartedAt: () => startedAt,
    onHeartbeatCritical: () => calls.push(Date.now()),
  });

  await tickOnce(m);
  assert.equal(calls.length, 0, 'recovery must not fire during boot window');
  closeDb(db);
});

test('Bug A: healthy heartbeat does not fire onHeartbeatCritical', async () => {
  const db = freshDb();
  const calls: number[] = [];
  const m = new HealthMonitor({
    db,
    getLLM: () => null,
    getLastTickAt: () => new Date(), // tick was just now — healthy
    getStartedAt: () => Date.now() - 10 * 60_000,
    onHeartbeatCritical: () => calls.push(Date.now()),
  });

  await tickOnce(m);
  assert.equal(calls.length, 0, 'healthy heartbeat must not fire recovery');
  closeDb(db);
});

test('alerts: failing invariant opens a row; passing on the next tick resolves it', async () => {
  const db = freshDb();
  let failing = true;
  const m = new HealthMonitor({
    db,
    getLLM: () => null,
    getLastTickAt: () => new Date(),
  });
  stubInvariants(m, [
    {
      name: 'test.flaky',
      severity: 'warning',
      symptom: '',
      cause: '',
      fix: '',
      check: () => (failing ? { ok: false, message: 'boom' } : { ok: true }),
    },
  ]);

  await tickOnce(m);
  const opened = openAlert(db, 'invariant', 'test.flaky');
  assert.ok(opened, 'failing invariant must open an alert');
  assert.equal(opened?.message, 'boom');

  failing = false;
  await tickOnce(m);
  assert.equal(openAlert(db, 'invariant', 'test.flaky'), undefined, 'recovery must resolve');
  assert.ok(resolvedAlert(db, 'invariant', 'test.flaky'), 'resolved_at must be stamped');
  closeDb(db);
});

test('alerts: critical-severity report records a critical alert', async () => {
  const db = freshDb();
  const m = new HealthMonitor({
    db,
    getLLM: () => null,
    getLastTickAt: () => new Date(),
    // disable notifications so the critical-toast path doesn't try osascript
    enableNotifications: false,
  });
  stubInvariants(m, [fakeInvariant('test.crit', { ok: false, message: 'down' }, 'critical')]);

  await tickOnce(m);
  const opened = openAlert(db, 'invariant', 'test.crit');
  assert.ok(opened, 'critical invariant must open an alert');
  assert.equal(opened?.severity, 'critical', 'severity must map critical→critical');
  closeDb(db);
});

test('timeout: a check exceeding the cap reports timed-out and records an alert', async () => {
  const db = freshDb();
  const m = new HealthMonitor({
    db,
    getLLM: () => null,
    getLastTickAt: () => new Date(),
    checkTimeoutMs: 50, // keep the test fast
  });
  stubInvariants(m, [
    {
      name: 'test.slow',
      severity: 'warning',
      symptom: '',
      cause: '',
      fix: '',
      // Never resolves — the timeout must win the race.
      check: () => new Promise<{ ok: boolean }>(() => {}),
    },
  ]);

  await tickOnce(m);
  const opened = openAlert(db, 'invariant', 'test.slow');
  assert.ok(opened, 'a timed-out check must record an alert');
  assert.equal(opened?.message, 'check timed out');
  closeDb(db);
});

test('overlap: a check still in flight is skipped, not re-run, and records nothing', async () => {
  const db = freshDb();
  let runs = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const m = new HealthMonitor({
    db,
    getLLM: () => null,
    getLastTickAt: () => new Date(),
    // High timeout so the slow check doesn't time out before we trigger overlap.
    checkTimeoutMs: 10_000,
  });
  stubInvariants(m, [
    {
      name: 'test.overlap',
      severity: 'warning',
      symptom: '',
      cause: '',
      fix: '',
      check: async () => {
        runs++;
        await gate; // first run parks here until released
        return { ok: true };
      },
    },
  ]);

  // Fire tick 1 but DON'T await — it parks inside the check, leaving it in flight.
  const first = tickOnce(m);
  // Yield so the check body runs and registers in `inFlight`.
  await new Promise((r) => setImmediate(r));
  assert.equal(runs, 1, 'first tick must have started the check');

  // Tick 2 fires while the first run is still in flight → overlap-skip.
  await tickOnce(m);
  assert.equal(runs, 1, 'overlapping tick must NOT re-run the check');
  // Overlap-skip says nothing about the condition → no alert recorded or resolved.
  assert.equal(openAlert(db, 'invariant', 'test.overlap'), undefined, 'no alert from overlap-skip');
  assert.equal(
    resolvedAlert(db, 'invariant', 'test.overlap'),
    undefined,
    'overlap-skip must not resolve either',
  );

  // Release the first run and let it finish cleanly.
  release();
  await first;
  closeDb(db);
});

test('robustness: an alert-store write failure does not throw out of the tick', async () => {
  const db = freshDb();
  // Drop the alerts table so recordAlert hits a DB-level error.
  db.exec('DROP TABLE alerts');
  const m = new HealthMonitor({
    db,
    getLLM: () => null,
    getLastTickAt: () => new Date(),
  });
  stubInvariants(m, [fakeInvariant('test.fail', { ok: false, message: 'x' })]);

  // Must resolve, not reject — alerting failure must never break the monitor tick.
  await assert.doesNotReject(tickOnce(m));
  closeDb(db);
});

test('sync-throw: a check() that throws synchronously produces a failing report, records an alert, and is NOT overlap-skipped on the next tick', async () => {
  const db = freshDb();
  let runs = 0;
  const m = new HealthMonitor({
    db,
    getLLM: () => null,
    getLastTickAt: () => new Date(),
    enableNotifications: false,
    checkTimeoutMs: 500,
  });

  // A companion healthy invariant — must also produce its report on tick 1,
  // proving the sync-throw didn't abort the remaining checks for that tick.
  let healthyRan = false;
  stubInvariants(m, [
    {
      name: 'test.sync-throw',
      severity: 'critical',
      symptom: '',
      cause: '',
      fix: '',
      check: () => {
        runs++;
        throw new Error('boom-sync');
      },
    },
    {
      name: 'test.sync-throw-companion',
      severity: 'warning',
      symptom: '',
      cause: '',
      fix: '',
      check: () => {
        healthyRan = true;
        return { ok: true };
      },
    },
  ]);

  // Tick 1 — sync throw must produce a failing report and record an alert.
  await tickOnce(m);
  assert.equal(runs, 1, 'tick 1 must have attempted the check');
  assert.ok(
    healthyRan,
    'companion invariant must still run on tick 1 (sync-throw must not abort remaining checks)',
  );
  const opened = openAlert(db, 'invariant', 'test.sync-throw');
  assert.ok(opened, 'sync-throw must record an alert');
  assert.equal(opened?.message, 'boom-sync', 'error message must be preserved');

  // Tick 2 — inFlight must have been cleaned up, so the invariant runs again
  // (not permanently overlap-skipped).
  await tickOnce(m);
  assert.equal(runs, 2, 'tick 2 must re-run the check (inFlight was cleaned up after sync-throw)');
  closeDb(db);
});

test('overlap: a timed-out check stays in-flight until it actually settles', async () => {
  const db = freshDb();
  let runs = 0;
  // Resolves when the slow check's async body finishes; resolved externally so
  // we can control precisely when the underlying work completes.
  let releaseSlowCheck!: () => void;
  const slowCheckDone = new Promise<void>((r) => {
    releaseSlowCheck = r;
  });

  const m = new HealthMonitor({
    db,
    getLLM: () => null,
    getLastTickAt: () => new Date(),
    // Short timeout so tick 1 times out well before the check body finishes.
    checkTimeoutMs: 50,
  });
  stubInvariants(m, [
    {
      name: 'test.timeout-overlap',
      severity: 'warning',
      symptom: '',
      cause: '',
      fix: '',
      check: async () => {
        runs++;
        // Simulate a slow check: takes ~200ms, well beyond the 50ms cap.
        await new Promise<void>((r) => setTimeout(r, 200));
        releaseSlowCheck();
        return { ok: true };
      },
    },
  ]);

  // Tick 1: times out at 50ms → reports 'check timed out'; check body still running.
  const tick1 = await tickOnce(m);
  assert.equal(runs, 1, 'tick 1 must have started the check');
  void tick1; // tickOnce returns void; just verifying it resolved

  // Tick 2: fires immediately — the original check is still in flight (hasn't
  // settled its 200ms body yet) — must be overlap-skipped, NOT re-run.
  await tickOnce(m);
  assert.equal(runs, 1, 'tick 2 must NOT re-run the still-pending check');

  // Wait for the original check body to finish, then tick 3 should run fresh.
  await slowCheckDone;
  // Give the inFlight.delete() finally a moment to execute.
  await new Promise((r) => setImmediate(r));

  await tickOnce(m);
  assert.equal(runs, 2, 'tick 3 after check settled must run a fresh check');

  closeDb(db);
});
