import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { closeDb, openDb } from '../../brain/memory/db.ts';
import { allMigrations, applyMigrations } from '../../brain/memory/migrations/index.ts';
import { HealthMonitor } from './health-monitor.ts';

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
