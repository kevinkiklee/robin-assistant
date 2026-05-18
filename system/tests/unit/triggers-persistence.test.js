import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import {
  fetchEventsAfter,
  lookupLastFire,
  readTriggerCursor,
  recordTriggerFire,
  writeTriggerCursor,
} from '../../cognition/triggers/persistence.js';
import { writeConfig as __wc } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';

const __h = join(tmpdir(), `robin-test-${process.pid}-${Math.random().toString(36).slice(2)}`);
mkdirSync(__h, { recursive: true });
process.env.ROBIN_HOME = __h;
await __wc({ embedder_profile: 'mxbai-1024' });

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../data/db/migrations'));
  return db;
}

test('readTriggerCursor returns nulls when no cursor set', async () => {
  const db = await fresh();
  const cur = await readTriggerCursor(db);
  assert.deepEqual(cur, { last_event_ts: null, last_event_id: null });
  await close(db);
});

test('writeTriggerCursor then readTriggerCursor roundtrips', async () => {
  const db = await fresh();
  const ts = new Date('2026-05-17T12:00:00Z');
  await writeTriggerCursor(db, { last_event_ts: ts, last_event_id: 'abc123' });
  const cur = await readTriggerCursor(db);
  assert.equal(cur.last_event_id, 'abc123');
  // SurrealDB returns datetime as Date; compare ms.
  const got = cur.last_event_ts instanceof Date ? cur.last_event_ts : new Date(cur.last_event_ts);
  assert.equal(+got, +ts);
  await close(db);
});

test('recordTriggerFire writes a row with all fields', async () => {
  const db = await fresh();
  await recordTriggerFire(db, {
    name: 'low-recovery',
    status: 'ok',
    event_id: 'e1',
    duration_ms: 42,
  });
  const [rows] = await db
    .query('SELECT name, status, event_id, duration_ms FROM trigger_fires')
    .collect();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'low-recovery');
  assert.equal(rows[0].status, 'ok');
  assert.equal(rows[0].event_id, 'e1');
  assert.equal(rows[0].duration_ms, 42);
  await close(db);
});

test('recordTriggerFire rejects invalid status via schema', async () => {
  const db = await fresh();
  await assert.rejects(recordTriggerFire(db, { name: 't', status: 'pizza', event_id: 'e1' }));
  await close(db);
});

test('lookupLastFire returns null when no ok fires', async () => {
  const db = await fresh();
  assert.equal(await lookupLastFire(db, 't'), null);
  // Skipped fires must not satisfy lookup either — only 'ok' counts.
  await recordTriggerFire(db, { name: 't', status: 'skipped', event_id: 'e1', reason: 'cooldown' });
  assert.equal(await lookupLastFire(db, 't'), null);
  await close(db);
});

test('lookupLastFire returns most recent ok fire time', async () => {
  const db = await fresh();
  await recordTriggerFire(db, { name: 't', status: 'ok', event_id: 'e1' });
  await new Promise((r) => setTimeout(r, 5));
  await recordTriggerFire(db, { name: 't', status: 'ok', event_id: 'e2' });
  await new Promise((r) => setTimeout(r, 5));
  await recordTriggerFire(db, { name: 'other', status: 'ok', event_id: 'eX' });
  const last = await lookupLastFire(db, 't');
  assert.ok(last);
  assert.ok(Number.isFinite(last.fired_at_ms));
  // last fire for 't' was e2; eX shouldn't influence it.
  assert.ok(Date.now() - last.fired_at_ms < 1000);
  await close(db);
});

test('fetchEventsAfter returns all events when cursor unset', async () => {
  const db = await fresh();
  await db.query('CREATE events SET source = "whoop", content = "a", ts = time::now()').collect();
  await new Promise((r) => setTimeout(r, 2));
  await db.query('CREATE events SET source = "gmail", content = "b", ts = time::now()').collect();
  const events = await fetchEventsAfter(db, { last_event_ts: null, last_event_id: null });
  assert.equal(events.length, 2);
  assert.deepEqual(
    events.map((e) => e.source),
    ['whoop', 'gmail'],
  );
  await close(db);
});

test('fetchEventsAfter excludes events at or before cursor', async () => {
  const db = await fresh();
  const [r1] = await db.query('CREATE events SET source = "a", content = "1"').collect();
  await new Promise((r) => setTimeout(r, 5));
  await db.query('CREATE events SET source = "b", content = "2"').collect();
  await new Promise((r) => setTimeout(r, 5));
  await db.query('CREATE events SET source = "c", content = "3"').collect();

  const cursor = { last_event_ts: r1[0].ts, last_event_id: null };
  const events = await fetchEventsAfter(db, cursor);
  // 'a' is at cursor (ts equal), strict `ts > cursor` excludes it.
  const sources = events.map((e) => e.source);
  assert.ok(!sources.includes('a'), `expected 'a' excluded, got ${JSON.stringify(sources)}`);
  assert.ok(sources.includes('b'));
  assert.ok(sources.includes('c'));
  await close(db);
});

test('fetchEventsAfter respects limit', async () => {
  const db = await fresh();
  for (let i = 0; i < 5; i += 1) {
    await db.query(`CREATE events SET source = "x", content = "${i}"`).collect();
    await new Promise((r) => setTimeout(r, 1));
  }
  const events = await fetchEventsAfter(
    db,
    { last_event_ts: null, last_event_id: null },
    { limit: 3 },
  );
  assert.equal(events.length, 3);
  await close(db);
});
