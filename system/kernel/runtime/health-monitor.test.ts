import { test } from 'node:test';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDb, closeDb } from '../../brain/memory/db.ts';
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
