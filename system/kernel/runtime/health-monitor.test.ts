import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { closeDb, openDb } from '../../brain/memory/db.ts';
import { allMigrations, applyMigrations } from '../../brain/memory/migrations/index.ts';
import { HealthMonitor } from './health-monitor.ts';

// HealthMonitor.tick is private; cast through unknown for the regression tests.
type HealthMonitorInternals = { tick: () => Promise<void> };
function tickOnce(m: HealthMonitor): Promise<void> {
  return (m as unknown as HealthMonitorInternals).tick();
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
