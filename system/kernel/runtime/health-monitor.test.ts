import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { closeDb, openDb, type RobinDb } from '../../brain/memory/db.ts';
import { allMigrations, applyMigrations } from '../../brain/memory/migrations/index.ts';
import type { Invariant } from '../invariants/types.ts';
import { listAlerts } from './alert-store.ts';
import { HealthMonitor } from './health-monitor.ts';
import { isRepairBroken, recordRepairFailure } from './repair-breaker.ts';

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

/** Same as fakeInvariant, but the result is recomputed on every check() call —
 *  lets a test flip an invariant's outcome between ticks. */
function fakeInvariantDynamic(
  name: string,
  fn: () => { ok: boolean; message?: string },
  severity: Invariant['severity'] = 'warning',
): Invariant {
  return {
    name,
    severity,
    symptom: '',
    cause: '',
    fix: '',
    check: fn,
  };
}

// buildInvariants is private; read it the same way stubInvariants replaces it,
// but call through to the REAL (unstubbed) implementation to get the actual
// built-in ordering. Constructing an invariant is side-effect-free (I/O only
// happens inside its .check()), so this is safe to call outside a tick.
function builtInvariantNamesForTest(m: HealthMonitor, userData: string): string[] {
  const invs = (
    m as unknown as { buildInvariants: (userData: string) => Invariant[] }
  ).buildInvariants(userData);
  return invs.map((i) => i.name);
}

/** Build a monitor wired to `invs` via stubInvariants — the file's existing
 *  injection pattern — for the dependsOn-deferral tests below. */
function monitorWith(db: RobinDb, invs: Invariant[]): HealthMonitor {
  const m = new HealthMonitor({
    db,
    getLLM: () => null,
    getLastTickAt: () => new Date(),
    enableNotifications: false,
  });
  stubInvariants(m, invs);
  return m;
}

/** Reach into the private deferredSince map (same pattern as the Bug A tests'
 *  direct access to firstHeartbeatCriticalAt) to simulate `ms` of elapsed
 *  continuous deferral for `name`. */
function backdateDeferral(m: HealthMonitor, name: string, ms: number): void {
  const map = (m as unknown as { deferredSince: Map<string, number> }).deferredSince;
  const since = map.get(name);
  if (since !== undefined) map.set(name, since - ms);
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

test('heartbeat: a host sleep resets the sustained counter and holds the verdict after wake', async () => {
  const db = freshDb();
  const calls: number[] = [];
  let wall = Date.now();
  let mono = 1_000_000;
  const m = new HealthMonitor({
    db,
    getLLM: () => null,
    // Scheduler silent 45 min — exactly what a 45-min nap looks like on wake.
    getLastTickAt: () => new Date(wall - 45 * 60_000),
    getStartedAt: () => wall - 3 * 60 * 60_000,
    onHeartbeatCritical: () => calls.push(wall),
    clock: { wall: () => wall, mono: () => mono },
  });
  await tickOnce(m);
  // Pretend the CRITICAL had already been sustained 31 min before the nap…
  (m as unknown as { firstHeartbeatCriticalAt: number }).firstHeartbeatCriticalAt =
    wall - 31 * 60_000;
  // …then the lid closes: 45 min of wall clock pass, 1 s of monotonic time.
  wall += 45 * 60_000;
  mono += 1_000;
  await tickOnce(m);
  assert.equal(calls.length, 0, 'waking from sleep must not kill the daemon');
  assert.equal(
    (m as unknown as { firstHeartbeatCriticalAt: number | null }).firstHeartbeatCriticalAt,
    null,
  );

  // Past the grace window with the scheduler STILL silent → a real wedge again:
  // counting restarts from zero (first observation defers).
  wall += 11 * 60_000;
  mono += 11 * 60_000;
  await tickOnce(m);
  assert.equal(calls.length, 0, 'first post-grace observation only starts the count');
  closeDb(db);
});

test('heartbeat: a macOS nap the monotonic clock ran through is caught by the kernel probe', async () => {
  // 10/27 regression: Node 24's monotonic clock kept counting through clamshell
  // sleep, so wall−mono drift was ~0 and every DarkWake opened a CRITICAL
  // heartbeat alert ("last tick was 958113ms ago"). The kernel's sleep record
  // must catch it and the alert must not open.
  const db = freshDb();
  const calls: number[] = [];
  let wall = Date.now();
  let mono = 1_000_000;
  const lastTick = wall;
  let sleptAt: number | null = null;
  const m = new HealthMonitor({
    db,
    getLLM: () => null,
    getLastTickAt: () => new Date(lastTick),
    getStartedAt: () => wall - 3 * 60 * 60_000,
    onHeartbeatCritical: () => calls.push(wall),
    clock: { wall: () => wall, mono: () => mono },
    sleepProbe: () => sleptAt,
  });
  await tickOnce(m);
  // 16-min nap: wall AND monotonic both advance (the macOS behaviour).
  sleptAt = wall + 1_000;
  wall += 16 * 60_000;
  mono += 16 * 60_000;
  await tickOnce(m);
  const open = listAlerts(db, {}).filter((a) => a.key === 'daemon.heartbeating');
  assert.equal(open.length, 0, 'waking from a nap must not open a heartbeat alert');
  assert.equal(calls.length, 0);
  closeDb(db);
});

test('heartbeat: a nap that lands mid-tick is caught before the heartbeat verdict', async () => {
  // 10/30 03:46Z: the tick's start-of-tick sleep check ran before the nap, the
  // host slept during an awaited check, and the heartbeat check ran after wake
  // with no wake recorded. CRITICAL opened 5 ms before the next tick logged
  // "host sleep detected".
  const db = freshDb();
  let wall = Date.now();
  let mono = 1_000_000;
  let sleptAt: number | null = null;
  let napped = false;
  const m = new HealthMonitor({
    db,
    getLLM: () => null,
    getLastTickAt: () => {
      // The heartbeat check is the first reader: the nap happens just before it.
      if (!napped) {
        napped = true;
        sleptAt = wall + 1_000;
        wall += 16 * 60_000;
        mono += 16 * 60_000;
      }
      return new Date(Date.now() - 16 * 60_000);
    },
    getStartedAt: () => wall - 3 * 60 * 60_000,
    clock: { wall: () => wall, mono: () => mono },
    sleepProbe: () => sleptAt,
  });
  await tickOnce(m);
  const open = listAlerts(db, {}).filter((a) => a.key === 'daemon.heartbeating');
  assert.equal(open.length, 0, 'a mid-tick nap must not open a heartbeat alert');
  assert.notEqual((m as unknown as { wokeAt: number | null }).wokeAt, null);
  closeDb(db);
});

test('heartbeat: a long tick gap with no kernel sleep record is not excused as a nap', async () => {
  // A synchronously blocked loop also delays the monitor's own tick; only the
  // kernel record may turn a gap into a sleep, or a real wedge would be held.
  const db = freshDb();
  let wall = Date.now();
  let mono = 1_000_000;
  const m = new HealthMonitor({
    db,
    getLLM: () => null,
    getLastTickAt: () => new Date(Date.now() - 16 * 60_000),
    getStartedAt: () => wall - 3 * 60 * 60_000,
    clock: { wall: () => wall, mono: () => mono },
    sleepProbe: () => wall - 60 * 60_000, // last sleep long before this window
  });
  await tickOnce(m);
  wall += 16 * 60_000;
  mono += 16 * 60_000;
  await tickOnce(m);
  assert.equal((m as unknown as { wokeAt: number | null }).wokeAt, null);
  assert.notEqual(
    (m as unknown as { firstHeartbeatCriticalAt: number | null }).firstHeartbeatCriticalAt,
    null,
    'the stall must keep counting toward escalation',
  );
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

test('dependsOn: failing dependent defers to failing parent — no child alert, parent gets observation', async () => {
  const db = freshDb();
  const parent = fakeInvariant('parent.down', { ok: false, message: 'parent broken' });
  const child: Invariant = {
    ...fakeInvariant('child.echo', { ok: false, message: 'stale because parent' }),
    dependsOn: ['parent.down'],
  };
  const m = monitorWith(db, [parent, child]);

  await tickOnce(m);
  const open = listAlerts(db, {});
  assert.deepStrictEqual(
    open.map((a) => a.key).sort(),
    ['parent.down'],
    'child.echo must NOT open its own alert while the parent is also failing',
  );
  const ctx = JSON.parse(open[0].context_json ?? '{}');
  assert.ok(
    ctx._observations.some((o: { deferred?: string }) => o.deferred === 'child.echo'),
    'the parent alert must carry a deferred observation from child.echo',
  );
  closeDb(db);
});

test('dependsOn: dependent opens its own alert once the parent recovers', async () => {
  const db = freshDb();
  const parentState = { ok: false };
  const parent = fakeInvariantDynamic('parent.down', () => ({ ok: parentState.ok, message: 'p' }));
  const child: Invariant = {
    ...fakeInvariant('child.echo', { ok: false, message: 'still failing' }),
    dependsOn: ['parent.down'],
  };
  const m = monitorWith(db, [parent, child]);

  await tickOnce(m); // deferred
  assert.equal(
    openAlert(db, 'invariant', 'child.echo'),
    undefined,
    'child.echo must stay deferred while the parent is failing',
  );

  parentState.ok = true;
  await tickOnce(m); // parent resolves; child now opens on this cycle
  const keys = listAlerts(db, {}).map((a) => a.key);
  assert.ok(keys.includes('child.echo'), 'child.echo must open once its parent recovers');
  closeDb(db);
});

test('dependsOn: deferral cap — after 6h of continuous deferral the child opens anyway, and stays open (no re-deferral flap)', async () => {
  const db = freshDb();
  const parent = fakeInvariant('parent.down', { ok: false, message: 'p' });
  const child: Invariant = {
    ...fakeInvariant('child.echo', { ok: false, message: 'c' }),
    dependsOn: ['parent.down'],
  };
  const m = monitorWith(db, [parent, child]);

  await tickOnce(m); // deferred, deferredSince set to "now"
  backdateDeferral(m, 'child.echo', 7 * 3_600_000); // simulate 7h of continuous deferral
  await tickOnce(m); // cap exceeded — child must open despite the parent still failing

  const afterCap = listAlerts(db, {}).find((a) => a.key === 'child.echo');
  assert.ok(afterCap, 'child.echo must open once the 6h defer cap is exceeded');
  assert.equal(afterCap?.fire_count, 1, 'first graduation opens with fire_count=1');

  // Regression: the parent is STILL failing on this next tick. If deferredSince
  // were cleared on cap-graduation, `since` would come back undefined here,
  // capExceeded would be false, and the child would silently re-enter deferral
  // (alert goes stale instead of refreshing). It must instead stay open and
  // refresh every tick once graduated past the cap.
  await tickOnce(m);
  const afterThird = listAlerts(db, {}).find((a) => a.key === 'child.echo');
  assert.ok(afterThird, 'child.echo must remain open on the tick after graduation');
  assert.equal(
    afterThird?.fire_count,
    2,
    'fire_count must keep incrementing — no re-deferral flap once past the cap',
  );
  closeDb(db);
});

test('dependsOn: unknown parent name opens a registry alert and is ignored (child fires normally)', async () => {
  const db = freshDb();
  const child: Invariant = {
    ...fakeInvariant('child.echo', { ok: false, message: 'c' }),
    dependsOn: ['no.such.parent'],
  };
  const m = monitorWith(db, [child]);

  await tickOnce(m);
  const keys = listAlerts(db, {}).map((a) => a.key);
  assert.ok(
    keys.includes('registry.invalid-depends-on'),
    'unknown dependsOn must open a registry alert',
  );
  assert.ok(keys.includes('child.echo'), 'invalid ref must be ignored — child fires normally');
  closeDb(db);
});

test('ladder: failing invariant with repair gets exactly one repair attempt, then escalates after N ticks', async () => {
  const db = freshDb();
  let repairs = 0;
  const inv: Invariant = {
    ...fakeInvariant('lad.der', { ok: false, message: 'down' }),
    repair: () => {
      repairs++;
    },
  };
  const monitor = monitorWith(db, [inv]);
  await tickOnce(monitor); // opens incident + attempts repair (still failing after re-check)
  assert.strictEqual(repairs, 1);
  for (let i = 0; i < 12; i++) await tickOnce(monitor); // repair never re-fires
  assert.strictEqual(repairs, 1);
  const row = listAlerts(db, {})[0];
  assert.ok(row.repair_attempted_at);
  assert.ok(row.escalated_at); // ≥10 failing ticks post-attempt
  closeDb(db);
});

test('ladder: repair that fixes the condition resolves with outcome repaired', async () => {
  const db = freshDb();
  const state = { ok: false };
  const inv: Invariant = {
    ...fakeInvariantDynamic('heal.me', () => ({ ok: state.ok, message: 'm' })),
    repair: () => {
      state.ok = true;
    },
  };
  const monitor = monitorWith(db, [inv]);
  await tickOnce(monitor); // fail → repair → re-check ok → resolve
  const row = listAlerts(db, { all: true })[0];
  assert.ok(row.resolved_at);
  assert.strictEqual(row.outcome, 'repaired');
  closeDb(db);
});

test('ladder regression: failingTicks cleared on in-tick repair-resolve — accumulated flap ticks must not carry into a later fresh incident', async () => {
  const db = freshDb();
  // Phase 'flap': each tick's initial check() fails (opening a fresh incident),
  // the repair "fixes" it transiently (fixedThisCall), and the immediate
  // post-repair re-check reports ok — resolving that incident within the same
  // tick. The very next tick reverts to failing, so a NEW incident opens next
  // time. Phase 'fresh': check() always fails and repair never fixes anything —
  // simulating a genuinely new, unrelated incident after the flap storm.
  let phase: 'flap' | 'fresh' = 'flap';
  let fixedThisCall = false;
  const inv: Invariant = {
    name: 'flap.then.fresh',
    severity: 'warning',
    symptom: '',
    cause: '',
    fix: '',
    check: () => {
      if (phase === 'flap') {
        const ok = fixedThisCall;
        fixedThisCall = false;
        return { ok, message: 'flap' };
      }
      return { ok: false, message: 'fresh-failing' };
    },
    repair: () => {
      if (phase === 'flap') fixedThisCall = true; // in-tick fix only — reverts next tick
      // phase 'fresh': repair does nothing (never fixes)
    },
  };
  const monitor = monitorWith(db, [inv]);

  // Drive 10 flap cycles. Each tick opens a fresh incident and closes it again
  // within the same tick via the in-tick repair path. Without the fix, the
  // failing-tick counter would accumulate to 10 across these closed incidents.
  for (let i = 0; i < 10; i++) {
    await tickOnce(monitor);
    assert.equal(
      listAlerts(db, {}).length,
      0,
      `flap cycle ${i} must resolve within the tick — no incident left open`,
    );
  }

  // Switch to a genuinely fresh, non-fixing incident.
  phase = 'fresh';
  await tickOnce(monitor); // first failing tick of the fresh incident
  const firstTick = listAlerts(db, {})[0];
  assert.ok(firstTick, 'fresh incident must be open');
  assert.ok(
    !firstTick.escalated_at,
    'fresh incident must NOT escalate on its first failing tick — accumulated flap ticks must not carry over',
  );

  // Drive it far enough to genuinely reach ESCALATE_AFTER_TICKS (10) failing ticks.
  for (let i = 0; i < 10; i++) await tickOnce(monitor);
  const laterTick = listAlerts(db, {})[0];
  assert.ok(
    laterTick.escalated_at,
    'fresh incident must escalate once it has genuinely accumulated ESCALATE_AFTER_TICKS failing ticks',
  );
  closeDb(db);
});

test('ladder: broken breaker skips repair() but still marks attempted so escalation can proceed', async () => {
  const db = freshDb();
  const userData = process.env.ROBIN_USER_DATA_DIR as string;
  let repairs = 0;
  const inv: Invariant = {
    ...fakeInvariant('breaker.broken', { ok: false, message: 'down' }),
    repair: () => {
      repairs++;
    },
  };
  // Trip the breaker before any tick runs, using the same default (no explicit
  // sha) resolution the monitor itself uses internally.
  recordRepairFailure(userData, 'breaker.broken');
  recordRepairFailure(userData, 'breaker.broken');
  assert.ok(isRepairBroken(userData, 'breaker.broken'), 'breaker must be tripped going in');

  const monitor = monitorWith(db, [inv]);
  await tickOnce(monitor);
  assert.strictEqual(repairs, 0, 'a broken breaker must skip the actual repair() call');
  const row = listAlerts(db, {})[0];
  assert.ok(
    row.repair_attempted_at,
    'markRepairAttempted must still fire on a broken breaker so escalation can proceed',
  );

  for (let i = 0; i < 10; i++) await tickOnce(monitor);
  const later = listAlerts(db, {})[0];
  assert.ok(later.escalated_at, 'incident must be able to escalate despite the broken breaker');
  assert.strictEqual(repairs, 0, 'repair() must never fire while the breaker stays broken');
  closeDb(db);
});

test('ladder: a throwing post-repair re-check does not notch the circuit breaker (only repair() throwing does)', async () => {
  const db = freshDb();
  const userData = process.env.ROBIN_USER_DATA_DIR as string;
  const inv: Invariant = {
    name: 'recheck.throws',
    severity: 'warning',
    symptom: '',
    cause: '',
    fix: '',
    check: () => {
      throw new Error('check always throws');
    },
    repair: () => {
      // repair() itself succeeds — the post-repair re-check (a second call to
      // check()) is what throws.
    },
  };
  const monitor = monitorWith(db, [inv]);
  await tickOnce(monitor);
  assert.strictEqual(
    isRepairBroken(userData, 'recheck.throws'),
    false,
    'a throwing re-check must not notch the breaker',
  );
  const row = listAlerts(db, {})[0];
  assert.ok(row.repair_attempted_at, 'the repair attempt must still be recorded');
  closeDb(db);
});

test('daemon parents are built before their dependents', () => {
  const db = freshDb();
  const m = new HealthMonitor({ db, getLLM: () => null, getLastTickAt: () => new Date() });
  const userData = process.env.ROBIN_USER_DATA_DIR as string;
  const names = builtInvariantNamesForTest(m, userData);
  assert.ok(
    names.indexOf('daemon.stable') < names.indexOf('integrations.staleness'),
    'daemon.stable must be built before its dependent integrations.staleness',
  );
  assert.ok(
    names.indexOf('daemon.heartbeating') < names.indexOf('jobs.not_erroring'),
    'daemon.heartbeating must be built before its dependent jobs.not_erroring',
  );
  closeDb(db);
});
