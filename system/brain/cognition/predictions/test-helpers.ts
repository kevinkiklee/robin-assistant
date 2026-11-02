import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type RobinDb } from '../../memory/db.ts';
import { allMigrations, applyMigrations } from '../../memory/migrations/index.ts';

/** Test-only: a migrated temp DB. */
export function freshDb(): RobinDb {
  const dir = mkdtempSync(join(tmpdir(), 'robin-pred-spec-'));
  mkdirSync(join(dir, 'state', 'db'), { recursive: true });
  const db = openDb(join(dir, 'state', 'db', 'robin.sqlite'));
  applyMigrations(db, allMigrations);
  return db;
}

/** Test-only: insert a raw event row. */
export function addEvent(
  db: RobinDb,
  kind: string,
  ts: string,
  payload: Record<string, unknown>,
  source = kind.split('.')[0],
): void {
  db.prepare(
    `INSERT INTO events (ts, kind, source, status, payload) VALUES (?, ?, ?, 'ok', ?)`,
  ).run(ts, kind, source, JSON.stringify(payload));
}

/** Test-only: a finalized WHOOP recovery for the morning of `day`. */
export function addRecovery(
  db: RobinDb,
  day: string,
  recovery: number,
  extra: Record<string, unknown> = {},
): void {
  addEvent(db, 'whoop.recovery', `${day}T12:10:00.000Z`, {
    external_id: `whoop:recovery:${day}`,
    score_state: 'SCORED',
    provisional: false,
    created_at: `${day}T12:00:00.000Z`,
    score: { recovery_score: recovery, resting_heart_rate: 50, hrv_rmssd_milli: 70 },
    ...extra,
  });
}
