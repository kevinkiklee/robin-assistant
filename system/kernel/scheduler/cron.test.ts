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
  const next = getNextRunAt('* * * * *', now);
  const diffMs = next.getTime() - now.getTime();
  assert.ok(diffMs > 0 && diffMs <= 60_000, `next was ${diffMs}ms in the future`);
});

test('cron: getNextRunAt for "0 3 * * *" is at 03:00 next', () => {
  const now = new Date('2026-05-18T12:00:00Z');
  const next = getNextRunAt('0 3 * * *', now);
  // Next 03:00 UTC after 2026-05-18T12:00:00Z is 2026-05-19T03:00:00Z
  assert.equal(next.toISOString(), '2026-05-19T03:00:00.000Z');
});

test('cron: scheduleCronJob enqueues a pending row at next-run time', () => {
  const db = freshDb();
  const now = new Date('2026-05-18T12:00:00Z');
  scheduleCronJob(db, { name: 'test.noop', cron: '0 3 * * *' }, now);
  const row = db
    .prepare("SELECT name, trigger_kind, scheduled_at FROM jobs WHERE name = 'test.noop'")
    .get() as { name: string; trigger_kind: string; scheduled_at: string };
  assert.equal(row.trigger_kind, 'cron');
  assert.equal(row.scheduled_at, '2026-05-19T03:00:00.000Z');
  closeDb(db);
});

test('cron: scheduleCronJob is idempotent (only one pending row per name)', () => {
  const db = freshDb();
  const now = new Date('2026-05-18T12:00:00Z');
  scheduleCronJob(db, { name: 'test.noop', cron: '0 3 * * *' }, now);
  scheduleCronJob(db, { name: 'test.noop', cron: '0 3 * * *' }, now);
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
