import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { closeDb, openDb } from '../../brain/memory/db.ts';
import { allMigrations, applyMigrations } from '../../brain/memory/migrations/index.ts';
import {
  getNextRunAt,
  isCronPayload,
  rescheduleCronAfterCompletion,
  scheduleCronJob,
} from './cron.ts';

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

test('cron: scheduleCronJob persists cron expression in payload for re-enqueue', () => {
  const db = freshDb();
  const now = new Date('2026-05-18T12:00:00Z');
  scheduleCronJob(db, { name: 'test.persist', cron: '*/5 * * * *', tz: 'UTC' }, now);
  const row = db.prepare("SELECT payload FROM jobs WHERE name = 'test.persist'").get() as {
    payload: string;
  };
  assert.equal(row.payload, '{"cron":"*/5 * * * *","tz":"UTC"}');
  closeDb(db);
});

test('cron: scheduleCronJob normalizes trigger_kind to cron when adopting a manual row', () => {
  const db = freshDb();
  // Simulate the production-observed shape: a pending row that was originally
  // inserted via a `manual` INSERT (e.g. operator unblocking the queue). When
  // `scheduleCronJob` runs at boot, it must adopt this row AND normalize
  // trigger_kind, otherwise `rescheduleCronAfterCompletion` will refuse to re-arm.
  db.prepare(
    "INSERT INTO jobs (name, trigger_kind, scheduled_at, state) VALUES ('test.adopt','manual',datetime('now'),'pending')",
  ).run();

  const now = new Date('2026-05-18T12:00:00Z');
  scheduleCronJob(db, { name: 'test.adopt', cron: '* * * * *' }, now);

  const row = db
    .prepare("SELECT trigger_kind, payload FROM jobs WHERE name='test.adopt' AND state='pending'")
    .get() as { trigger_kind: string; payload: string };
  assert.equal(row.trigger_kind, 'cron');
  assert.equal(row.payload, '{"cron":"* * * * *"}');
  closeDb(db);
});

test('cron: scheduleCronJob omits tz from payload when unset', () => {
  const db = freshDb();
  const now = new Date('2026-05-18T12:00:00Z');
  scheduleCronJob(db, { name: 'test.notz', cron: '* * * * *' }, now);
  const row = db.prepare("SELECT payload FROM jobs WHERE name = 'test.notz'").get() as {
    payload: string;
  };
  // No `tz` key — confirms we don't write `tz: undefined` which would silently
  // pin the row to whatever resolveTz() returned at insert time.
  assert.equal(row.payload, '{"cron":"* * * * *"}');
  closeDb(db);
});

test('isCronPayload: accepts valid payloads, rejects malformed', () => {
  assert.equal(isCronPayload({ cron: '* * * * *' }), true);
  assert.equal(isCronPayload({ cron: '* * * * *', tz: 'UTC' }), true);
  assert.equal(isCronPayload({ cron: 5 }), false);
  assert.equal(isCronPayload({ tz: 'UTC' }), false);
  assert.equal(isCronPayload({ cron: '*', tz: 42 }), false);
  assert.equal(isCronPayload(null), false);
  assert.equal(isCronPayload('cron'), false);
});

test('rescheduleCronAfterCompletion: enqueues next instance for cron rows', () => {
  const db = freshDb();
  const t0 = new Date('2026-05-18T12:00:00Z');
  scheduleCronJob(db, { name: 'test.recur', cron: '* * * * *', tz: 'UTC' }, t0);
  const initial = db
    .prepare(
      "SELECT id, scheduled_at, payload FROM jobs WHERE name='test.recur' AND state='pending'",
    )
    .get() as { id: number; scheduled_at: string; payload: string };

  // Simulate handler completion + cleanup that completeJob would do, then re-arm.
  db.prepare("UPDATE jobs SET state='completed' WHERE id=?").run(initial.id);
  const t1 = new Date('2026-05-18T12:00:05Z'); // 5s later
  const did = rescheduleCronAfterCompletion(
    db,
    { name: 'test.recur', trigger_kind: 'cron', payload: initial.payload },
    t1,
  );
  assert.equal(did, true);

  const next = db
    .prepare(
      "SELECT scheduled_at, COUNT(*) OVER () as n FROM jobs WHERE name='test.recur' AND state='pending'",
    )
    .get() as { scheduled_at: string; n: number };
  assert.equal(next.n, 1);
  // Next run at 12:01:00 (the next * * * * * boundary after 12:00:05)
  assert.equal(next.scheduled_at, '2026-05-18T12:01:00.000Z');
  closeDb(db);
});

test('rescheduleCronAfterCompletion: no-op for non-cron rows', () => {
  const db = freshDb();
  db.prepare(
    "INSERT INTO jobs (name, trigger_kind, scheduled_at, state) VALUES ('test.event','event',datetime('now'),'completed')",
  ).run();
  const did = rescheduleCronAfterCompletion(db, {
    name: 'test.event',
    trigger_kind: 'event',
    payload: null,
  });
  assert.equal(did, false);
  const n = (
    db
      .prepare("SELECT COUNT(*) as c FROM jobs WHERE name='test.event' AND state='pending'")
      .get() as {
      c: number;
    }
  ).c;
  assert.equal(n, 0);
  closeDb(db);
});

test('rescheduleCronAfterCompletion: no-op when payload is null or malformed', () => {
  const db = freshDb();
  // null payload — older cron rows from before Bug C fix have payload=NULL; we
  // can't recover their cron, so we no-op rather than guess. They'll re-arm
  // naturally on next daemon boot via registerCognitionJobs.
  let did = rescheduleCronAfterCompletion(db, {
    name: 'test.legacy',
    trigger_kind: 'cron',
    payload: null,
  });
  assert.equal(did, false);

  // Malformed JSON
  did = rescheduleCronAfterCompletion(db, {
    name: 'test.bad',
    trigger_kind: 'cron',
    payload: 'not json',
  });
  assert.equal(did, false);

  // Valid JSON, wrong shape
  did = rescheduleCronAfterCompletion(db, {
    name: 'test.shape',
    trigger_kind: 'cron',
    payload: '{"different":"shape"}',
  });
  assert.equal(did, false);
  closeDb(db);
});
