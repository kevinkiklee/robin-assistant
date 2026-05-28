import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { closeDb, openDb } from '../db.ts';
import { allMigrations, applyMigrations } from './index.ts';

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'robin-mig-'));
  mkdirSync(join(dir, 'state', 'db'), { recursive: true });
  return openDb(join(dir, 'state', 'db', 'robin.sqlite'));
}

test('schema 001: all expected tables exist after apply', () => {
  const db = freshDb();
  applyMigrations(db, allMigrations);
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all() as Array<{ name: string }>;
  const names = tables.map((t) => t.name);
  for (const expected of ['events', 'events_content', 'jobs', 'integration_state', '_migrations']) {
    assert.ok(names.includes(expected), `table ${expected} missing from schema 001`);
  }
  closeDb(db);
});

test('schema 001: events table has expected columns', () => {
  const db = freshDb();
  applyMigrations(db, allMigrations);
  const cols = db.prepare('PRAGMA table_info(events)').all() as Array<{
    name: string;
    notnull: number;
  }>;
  const colNames = cols.map((c) => c.name).sort();
  assert.deepEqual(colNames, [
    'actor',
    'content_ref',
    'duration_ms',
    'id',
    'import_key', // added in migration 012 (idempotent import dedup key)
    'kind',
    'payload',
    'source',
    'status',
    'ts',
  ]);
  closeDb(db);
});

test('migrations apply cleanly up to latest version', () => {
  const db = freshDb();
  applyMigrations(db, allMigrations);
  const row = db.prepare('SELECT MAX(version) AS v FROM _migrations').get() as { v: number };
  assert.equal(row.v, allMigrations.length);
  closeDb(db);
});

test('migration 015 + 017: noise_blocklist stays, hygiene_review is dropped (no user-facing triage)', () => {
  const db = freshDb();
  applyMigrations(db, allMigrations);
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all() as Array<{ name: string }>;
  const names = tables.map((t) => t.name);
  assert.ok(names.includes('noise_blocklist'), 'noise_blocklist table missing');
  assert.ok(!names.includes('hygiene_review'), 'hygiene_review should be dropped by 017');

  const cols = db.prepare('PRAGMA table_info(noise_blocklist)').all() as Array<{ name: string }>;
  const colNames = cols.map((c) => c.name).sort();
  assert.deepEqual(colNames, ['added_at', 'id', 'name', 'reason', 'source']);
  closeDb(db);
});

test('migration 014: corrections has a topic column', () => {
  const db = freshDb();
  applyMigrations(db, allMigrations);
  const cols = db.prepare(`PRAGMA table_info(corrections)`).all() as Array<{ name: string }>;
  assert.ok(
    cols.some((c) => c.name === 'topic'),
    'expected topic column on corrections',
  );
  closeDb(db);
});

test('migration 013: belief_candidates has a provenance column', () => {
  const db = freshDb();
  applyMigrations(db, allMigrations);
  const cols = db.prepare(`PRAGMA table_info(belief_candidates)`).all() as Array<{ name: string }>;
  assert.ok(
    cols.some((c) => c.name === 'provenance'),
    'expected provenance column on belief_candidates',
  );
  closeDb(db);
});

test('migration 012: import_key dedup indexes exist on events and relations', () => {
  const db = freshDb();
  applyMigrations(db, allMigrations);
  const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as Array<{
    name: string;
  }>;
  const names = idx.map((i) => i.name);
  assert.ok(names.includes('events_import_key'), 'events_import_key index missing');
  assert.ok(names.includes('relations_import_key'), 'relations_import_key index missing');
  closeDb(db);
});

test('migration 010: events_vec is a 3072-dim vec0 table', () => {
  const db = freshDb();
  applyMigrations(db, allMigrations);
  const def = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='events_vec'")
    .get() as { sql: string } | undefined;
  assert.ok(def, 'events_vec table missing after migrations');
  assert.match(def.sql, /vec0\(embedding float\[3072\]\)/);

  // vec0 enforces the declared width: a 3072-dim vector inserts, a 4096-dim one is rejected.
  const insert = db.prepare('INSERT INTO events_vec(rowid, embedding) VALUES (?, ?)');
  insert.run(1n, Buffer.from(new Float32Array(3072).buffer));
  assert.throws(
    () => insert.run(2n, Buffer.from(new Float32Array(4096).buffer)),
    /Dimension mismatch/,
  );
  closeDb(db);
});

test('migration 011: agent_usage table + ts index exist', () => {
  const db = freshDb();
  applyMigrations(db, allMigrations);
  const def = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='agent_usage'")
    .get() as { sql: string } | undefined;
  assert.ok(def, 'agent_usage table missing after migrations');

  const cols = db.prepare('PRAGMA table_info(agent_usage)').all() as Array<{ name: string }>;
  const colNames = cols.map((c) => c.name).sort();
  assert.deepEqual(colNames, [
    'cost_usd',
    'id',
    'input_tokens',
    'label',
    'output_tokens',
    'status',
    'subtype',
    'surface',
    'ts',
    'turns',
  ]);

  const idx = db
    .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='agent_usage'")
    .all() as Array<{ name: string }>;
  assert.ok(idx.map((i) => i.name).includes('idx_agent_usage_ts'));
  closeDb(db);
});

test('schema 001: indexes on events are created', () => {
  const db = freshDb();
  applyMigrations(db, allMigrations);
  const idx = db
    .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='events'")
    .all() as Array<{ name: string }>;
  const names = idx.map((i) => i.name);
  assert.ok(names.includes('events_ts'));
  assert.ok(names.includes('events_kind_ts'));
  assert.ok(names.includes('events_source_ts'));
  closeDb(db);
});

test('migration 016: perf indexes for ingest dedup + candidate dedup exist', () => {
  const db = freshDb();
  applyMigrations(db, allMigrations);
  const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as Array<{
    name: string;
  }>;
  const names = idx.map((i) => i.name);
  assert.ok(names.includes('events_source_external_id'), 'events_source_external_id index missing');
  assert.ok(
    names.includes('belief_candidates_pending_topic_claim'),
    'belief_candidates_pending_topic_claim index missing',
  );

  // The events index is partial — query plan should use it for the upsert probe.
  const plan = db
    .prepare(
      `EXPLAIN QUERY PLAN
       SELECT id FROM events
       WHERE source = ? AND json_extract(payload, '$.external_id') = ?`,
    )
    .all('gmail', 'msg-123') as Array<{ detail: string }>;
  const planText = plan.map((p) => p.detail).join(' | ');
  assert.match(
    planText,
    /events_source_external_id/,
    `query plan did not use the new index: ${planText}`,
  );

  // The candidate index is partial on status='pending' — dedup probe should hit it.
  const candidatePlan = db
    .prepare(
      `EXPLAIN QUERY PLAN
       SELECT id FROM belief_candidates
       WHERE status = 'pending' AND topic = ? AND claim = ?`,
    )
    .all('mood', 'kevin felt good today') as Array<{ detail: string }>;
  const candidatePlanText = candidatePlan.map((p) => p.detail).join(' | ');
  assert.match(
    candidatePlanText,
    /belief_candidates_pending_topic_claim/,
    `candidate dedup did not use the new index: ${candidatePlanText}`,
  );
  closeDb(db);
});
