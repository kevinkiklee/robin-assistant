import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { closeDb, openDb } from '../../brain/memory/db.ts';
import { allMigrations, applyMigrations } from '../../brain/memory/migrations/index.ts';
import { writeTelemetry } from './write.ts';

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'robin-tel-'));
  mkdirSync(join(dir, 'state', 'db'), { recursive: true });
  const db = openDb(join(dir, 'state', 'db', 'robin.sqlite'));
  applyMigrations(db, allMigrations);
  return db;
}

test('telemetry: writes a valid event', () => {
  const db = freshDb();
  const id = writeTelemetry(db, 'daemon.start', { version: '3.0.0-alpha.0' }, { source: 'test' });
  assert.ok(id > 0);
  const row = db.prepare('SELECT * FROM events WHERE id = ?').get(id) as {
    kind: string;
    payload: string;
  };
  assert.equal(row.kind, 'daemon.start');
  const parsed = JSON.parse(row.payload);
  assert.equal(parsed.version, '3.0.0-alpha.0');
  closeDb(db);
});

test('telemetry: rejects invalid payload', () => {
  const db = freshDb();
  // version is required by schema; passing object missing it should throw
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  assert.throws(
    () => writeTelemetry(db, 'daemon.start', {} as any, { source: 'test' }),
    /Invalid payload/,
  );
  closeDb(db);
});

test('telemetry: records duration and status', () => {
  const db = freshDb();
  const id = writeTelemetry(
    db,
    'scheduler.tick',
    { jobs_claimed: 1, jobs_completed: 1, jobs_errored: 0 },
    { source: 'scheduler', duration_ms: 42, status: 'ok' },
  );
  const row = db.prepare('SELECT duration_ms, status FROM events WHERE id = ?').get(id) as {
    duration_ms: number;
    status: string;
  };
  assert.equal(row.duration_ms, 42);
  assert.equal(row.status, 'ok');
  closeDb(db);
});
