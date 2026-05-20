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

test('ingest: payload.external_id triggers upsert on second call', () => {
  const db = freshDb();
  const first = ingest(db, null, {
    kind: 'integration.tick',
    source: 'demo',
    content: 'original body',
    payload: { external_id: 'demo:item:1', n: 1 },
  });
  assert.equal(first.upserted, false);

  const second = ingest(db, null, {
    kind: 'integration.tick',
    source: 'demo',
    content: 'updated body',
    payload: { external_id: 'demo:item:1', n: 2 },
  });
  assert.equal(second.upserted, true);
  assert.equal(second.eventId, first.eventId);
  assert.equal(second.contentId, first.contentId);

  const rowCount = db
    .prepare(`SELECT COUNT(*) AS c FROM events WHERE source = 'demo'`)
    .get() as { c: number };
  assert.equal(rowCount.c, 1, 'second call must update, not append');

  const ev = db
    .prepare(`SELECT payload, content_ref FROM events WHERE id = ?`)
    .get(first.eventId) as { payload: string; content_ref: number };
  assert.equal(JSON.parse(ev.payload).n, 2);

  const content = db
    .prepare(`SELECT body, embedding FROM events_content WHERE id = ?`)
    .get(ev.content_ref) as { body: string; embedding: Buffer | null };
  assert.equal(content.body, 'updated body');
  assert.equal(content.embedding, null, 'upsert must invalidate the prior embedding');
  closeDb(db);
});

test('ingest: different sources with same external_id stay distinct', () => {
  const db = freshDb();
  const a = ingest(db, null, {
    kind: 'integration.tick',
    source: 'src_a',
    payload: { external_id: 'shared:id' },
  });
  const b = ingest(db, null, {
    kind: 'integration.tick',
    source: 'src_b',
    payload: { external_id: 'shared:id' },
  });
  assert.notEqual(a.eventId, b.eventId);
  assert.equal(a.upserted, false);
  assert.equal(b.upserted, false);
  closeDb(db);
});

test('ingest: payload without external_id never upserts', () => {
  const db = freshDb();
  const a = ingest(db, null, { kind: 'x', source: 's', content: 'one', payload: { n: 1 } });
  const b = ingest(db, null, { kind: 'x', source: 's', content: 'two', payload: { n: 2 } });
  assert.notEqual(a.eventId, b.eventId);
  assert.equal(a.upserted, false);
  assert.equal(b.upserted, false);
  closeDb(db);
});
