import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { closeDb, openDb } from '../../brain/memory/db.ts';
import { allMigrations, applyMigrations } from '../../brain/memory/migrations/index.ts';
import { getNextRunAt, scheduleCronJob } from './cron.ts';

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'robin-cron-'));
  mkdirSync(join(dir, 'state', 'db'), { recursive: true });
  const db = openDb(join(dir, 'state', 'db', 'robin.sqlite'));
  applyMigrations(db, allMigrations);
  return db;
}

test('cron: getNextRunAt for "* * * * *" is within the next minute', () => {
  const now = new Date('2026-05-18T12:00:00Z');
  const next = getNextRunAt('* * * * *', now, 'UTC');
  const diffMs = next.getTime() - now.getTime();
  assert.ok(diffMs > 0 && diffMs <= 60_000, `next was ${diffMs}ms in the future`);
});

test('cron: getNextRunAt for "0 3 * * *" in UTC is at 03:00 UTC next', () => {
  const now = new Date('2026-05-18T12:00:00Z');
  const next = getNextRunAt('0 3 * * *', now, 'UTC');
  assert.equal(next.toISOString(), '2026-05-19T03:00:00.000Z');
});

test('cron: same expression in different TZ produces different next times', () => {
  const now = new Date('2026-05-18T12:00:00Z');
  const utc = getNextRunAt('0 3 * * *', now, 'UTC');
  const ny = getNextRunAt('0 3 * * *', now, 'America/New_York');
  // 03:00 UTC = 23:00 ET previous day → next ET 03:00 has already passed at 12:00Z,
  // so next NY-03:00 is on 2026-05-19 07:00 UTC (during EDT = UTC-4).
  assert.notEqual(utc.toISOString(), ny.toISOString());
  assert.equal(ny.toISOString(), '2026-05-19T07:00:00.000Z');
});

test('cron: scheduleCronJob enqueues a pending row at next-run time', () => {
  const db = freshDb();
  const now = new Date('2026-05-18T12:00:00Z');
  scheduleCronJob(db, { name: 'test.noop', cron: '0 3 * * *', tz: 'UTC' }, now);
  const row = db
    .prepare("SELECT name, trigger_kind, scheduled_at FROM jobs WHERE name = 'test.noop'")
    .get() as { name: string; trigger_kind: string; scheduled_at: string };
  assert.equal(row.trigger_kind, 'cron');
  assert.equal(row.scheduled_at, '2026-05-19T03:00:00.000Z');
  closeDb(db);
});

test('cron: scheduleCronJob is idempotent (one pending row, same TZ → no update)', () => {
  const db = freshDb();
  const now = new Date('2026-05-18T12:00:00Z');
  scheduleCronJob(db, { name: 'test.noop', cron: '0 3 * * *', tz: 'UTC' }, now);
  scheduleCronJob(db, { name: 'test.noop', cron: '0 3 * * *', tz: 'UTC' }, now);
  const count = (
    db
      .prepare("SELECT COUNT(*) as c FROM jobs WHERE name = 'test.noop' AND state = 'pending'")
      .get() as {
      c: number;
    }
  ).c;
  assert.equal(count, 1);
  closeDb(db);
});

test('cron: scheduleCronJob refreshes pending row when TZ changes the next-run time', () => {
  const db = freshDb();
  const now = new Date('2026-05-18T12:00:00Z');
  scheduleCronJob(db, { name: 'test.tzchange', cron: '0 3 * * *', tz: 'UTC' }, now);
  const before = db.prepare("SELECT scheduled_at FROM jobs WHERE name = 'test.tzchange'").get() as {
    scheduled_at: string;
  };
  assert.equal(before.scheduled_at, '2026-05-19T03:00:00.000Z');

  // Reseed with the same cron but a different TZ — pending row should update in place.
  scheduleCronJob(db, { name: 'test.tzchange', cron: '0 3 * * *', tz: 'America/New_York' }, now);
  const after = db
    .prepare(
      "SELECT scheduled_at, COUNT(*) OVER () AS n FROM jobs WHERE name = 'test.tzchange' AND state = 'pending'",
    )
    .get() as { scheduled_at: string; n: number };
  assert.equal(after.n, 1);
  assert.equal(after.scheduled_at, '2026-05-19T07:00:00.000Z');
  closeDb(db);
});
