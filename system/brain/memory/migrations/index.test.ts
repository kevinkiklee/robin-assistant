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

test('events_vec is a 3072-dim int8 vec0 table after all migrations', () => {
  // Migration 010 created it as float[3072]; migration 023 converts it to int8[3072]
  // (4× smaller, faster KNN). After the full chain it is int8.
  const db = freshDb();
  applyMigrations(db, allMigrations);
  const def = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='events_vec'")
    .get() as { sql: string } | undefined;
  assert.ok(def, 'events_vec table missing after migrations');
  assert.match(def.sql, /vec0\(embedding int8\[3072\]\)/);

  // vec0 enforces the declared width: a 3072-dim int8 vector inserts, a 4096-dim one is rejected.
  const insert = db.prepare('INSERT INTO events_vec(rowid, embedding) VALUES (?, vec_int8(?))');
  insert.run(1n, JSON.stringify(new Array(3072).fill(0)));
  assert.throws(() => insert.run(2n, JSON.stringify(new Array(4096).fill(0))), /mismatch/i);
  closeDb(db);
});

test('agent_usage: full schema + indexes exist', () => {
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
    'impact',
    'input_tokens',
    'label',
    'outcome',
    'output_tokens',
    'status',
    'structured_json',
    'subtype',
    'surface',
    'ts',
    'turns',
    'verified',
  ]);

  const idx = db
    .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='agent_usage'")
    .all() as Array<{ name: string }>;
  const idxNames = idx.map((i) => i.name);
  assert.ok(idxNames.includes('idx_agent_usage_ts'));
  assert.ok(idxNames.includes('idx_agent_usage_label_ts'));
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

test('migration 020: belief_candidates gains embedding + corroboration_count', () => {
  const db = freshDb();
  applyMigrations(db, allMigrations);
  const cols = db.prepare(`PRAGMA table_info(belief_candidates)`).all() as Array<{
    name: string;
    dflt_value: string | null;
  }>;
  const byName = new Map(cols.map((c) => [c.name, c]));
  assert.ok(byName.has('embedding'), 'expected embedding column on belief_candidates');
  const corr = byName.get('corroboration_count');
  assert.ok(corr, 'expected corroboration_count column on belief_candidates');
  assert.equal(corr.dflt_value, '1', 'corroboration_count should default to 1');
  closeDb(db);
});

test('migration 020: recall_log gains top_score, session_id, injected_content_ids', () => {
  const db = freshDb();
  applyMigrations(db, allMigrations);
  const cols = db.prepare(`PRAGMA table_info(recall_log)`).all() as Array<{ name: string }>;
  const names = cols.map((c) => c.name);
  for (const expected of ['top_score', 'session_id', 'injected_content_ids']) {
    assert.ok(names.includes(expected), `expected ${expected} column on recall_log`);
  }
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
