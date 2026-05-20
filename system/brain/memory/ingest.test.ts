import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { closeDb, openDb } from './db.ts';
import { ingest } from './ingest.ts';
import { allMigrations, applyMigrations } from './migrations/index.ts';

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'robin-ingest-'));
  mkdirSync(join(dir, 'state', 'db'), { recursive: true });
  const db = openDb(join(dir, 'state', 'db', 'robin.sqlite'));
  applyMigrations(db, allMigrations);
  return db;
}

test('ingest: writes event + content row with embedding NULL (deferred to backfill)', () => {
  const db = freshDb();
  const r = ingest(db, null, { kind: 'test', source: 't', content: 'hello' });
  assert.ok(r.eventId > 0);
  assert.ok(r.contentId);

  const row = db
    .prepare('SELECT body, embedding FROM events_content WHERE id = ?')
    .get(r.contentId) as { body: string; embedding: Buffer | null };
  assert.equal(row.body, 'hello');
  assert.equal(row.embedding, null);
  // events_vec is also empty until the backfill job runs
  const vecRow = db
    .prepare('SELECT COUNT(*) AS c FROM events_vec WHERE rowid = ?')
    .get(r.contentId) as { c: number };
  assert.equal(vecRow.c, 0);
  closeDb(db);
});

test('ingest: no content → only event row, no content row', () => {
  const db = freshDb();
  const r = ingest(db, null, { kind: 'test', source: 't', payload: { foo: 1 } });
  assert.ok(r.eventId > 0);
  assert.equal(r.contentId, undefined);
  closeDb(db);
});

test('ingest: llm parameter is accepted but unused (kept for API compat)', () => {
  // The legacy signature took an LLMDispatcher to drive inline embedding. Embedding is
  // now deferred. Pass anything for compat — it must be ignored without error.
  const db = freshDb();
  const r = ingest(db, null, { kind: 'test', source: 't', content: 'still-works' });
  assert.ok(r.eventId > 0);
  closeDb(db);
});
