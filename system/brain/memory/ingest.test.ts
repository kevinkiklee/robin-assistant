import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDb, closeDb } from './db.ts';
import { allMigrations, applyMigrations } from './migrations/index.ts';
import { LLMDispatcher } from '../llm/dispatcher.ts';
import type { LLMProvider } from '../llm/types.ts';
import { ingest } from './ingest.ts';

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'robin-ingest-'));
  mkdirSync(join(dir, 'state', 'db'), { recursive: true });
  const db = openDb(join(dir, 'state', 'db', 'robin.sqlite'));
  applyMigrations(db, allMigrations);
  return db;
}

function embedProvider(vec: number[] | null): LLMProvider {
  return {
    name: 'embed-mock',
    capabilities: new Set(['embed']),
    meta: { contextWindow: 0, inputPricePerM: 0, outputPricePerM: 0 },
    invoke: async () => { throw new Error('not implemented'); },
    embed: async () => {
      if (vec) return [vec];
      throw new Error('embedder unavailable');
    },
  };
}

test('ingest: writes event + content row + embedding (events_content + events_vec)', async () => {
  const db = freshDb();
  const llm = new LLMDispatcher();
  llm.register('e', embedProvider(new Array(1024).fill(0.1)));
  llm.assign('embed', 'e');

  const r = await ingest(db, llm, { kind: 'test', source: 't', content: 'hello' });
  assert.ok(r.eventId > 0);
  assert.ok(r.contentId);
  assert.equal(r.embedded, true);

  const row = db.prepare('SELECT length(embedding) AS len FROM events_content WHERE id = ?').get(r.contentId) as { len: number };
  assert.equal(row.len, 1024 * 4);
  // verify events_vec also populated
  const vecRow = db.prepare('SELECT COUNT(*) AS c FROM events_vec WHERE rowid = ?').get(r.contentId) as { c: number };
  assert.equal(vecRow.c, 1);
  closeDb(db);
});

test('ingest: event row succeeds even when embed throws', async () => {
  const db = freshDb();
  const llm = new LLMDispatcher();
  llm.register('e', embedProvider(null));
  llm.assign('embed', 'e');

  const r = await ingest(db, llm, { kind: 'test', source: 't', content: 'world' });
  assert.ok(r.eventId > 0);
  assert.equal(r.embedded, false);
  assert.match(r.embedError!, /embedder unavailable/);

  const ev = db.prepare('SELECT id FROM events WHERE id = ?').get(r.eventId);
  assert.ok(ev);
  closeDb(db);
});

test('ingest: no content → only event row', async () => {
  const db = freshDb();
  const r = await ingest(db, null, { kind: 'test', source: 't', payload: { foo: 1 } });
  assert.ok(r.eventId > 0);
  assert.equal(r.contentId, undefined);
  assert.equal(r.embedded, false);
  closeDb(db);
});
