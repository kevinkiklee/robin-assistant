import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { LLMDispatcher } from '../llm/dispatcher.ts';
import type { LLMProvider } from '../llm/types.ts';
import { closeDb, openDb } from './db.ts';
import { ingest } from './ingest.ts';
import { allMigrations, applyMigrations } from './migrations/index.ts';
import { recall } from './recall.ts';

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'robin-recall-'));
  mkdirSync(join(dir, 'state', 'db'), { recursive: true });
  const db = openDb(join(dir, 'state', 'db', 'robin.sqlite'));
  applyMigrations(db, allMigrations);
  return db;
}

function mockLLM(vec: number[]): LLMDispatcher {
  const provider: LLMProvider = {
    name: 'mock',
    capabilities: new Set(['embed']),
    meta: { contextWindow: 0, inputPricePerM: 0, outputPricePerM: 0 },
    invoke: async () => {
      throw new Error('nope');
    },
    embed: async () => [vec],
  };
  const d = new LLMDispatcher();
  d.register('e', provider);
  d.assign('embed', 'e');
  return d;
}

test('recall: lex mode returns FTS hits', async () => {
  const db = freshDb();
  ingest(db, null, { kind: 't', source: 's', content: 'kevin loves photography in Lisbon' });
  ingest(db, null, { kind: 't', source: 's', content: 'the weather today is sunny' });

  const hits = await recall(db, null, 'Lisbon', { mode: 'lex' });
  assert.equal(hits.length, 1);
  assert.match(hits[0].body, /Lisbon/);
  closeDb(db);
});

test('recall: lex returns empty when no matches', async () => {
  const db = freshDb();
  const hits = await recall(db, null, 'nonexistent', { mode: 'lex' });
  assert.equal(hits.length, 0);
  closeDb(db);
});

test('recall: logs every query to recall_log with result count', async () => {
  const db = freshDb();
  ingest(db, null, { kind: 't', source: 's', content: 'kevin loves photography in Lisbon' });

  await recall(db, null, 'Lisbon', { mode: 'lex' });
  // Hyphen would crash a naive FTS5 query (treated as NOT operator) — the sanitizer
  // strips it. Combined with the never-seen word, this asserts both "logs even when
  // no hits" and "doesn't crash on natural-language punctuation."
  await recall(db, null, 'nonexistent-thing-xyz', { mode: 'lex' });

  const rows = db
    .prepare(`SELECT query_hash, result_count, outcome FROM recall_log ORDER BY id`)
    .all() as Array<{ query_hash: string; result_count: number; outcome: string }>;
  assert.equal(rows.length, 2);
  assert.equal(rows[0].result_count, 1);
  assert.equal(rows[0].outcome, 'pending');
  assert.equal(rows[1].result_count, 0);
  // Distinct hashes for distinct queries
  assert.notEqual(rows[0].query_hash, rows[1].query_hash);
  closeDb(db);
});

test('recall: repeat queries share the same query_hash so aggregation is meaningful', async () => {
  const db = freshDb();
  ingest(db, null, { kind: 't', source: 's', content: 'a body about Lisbon' });
  await recall(db, null, 'Lisbon', { mode: 'lex' });
  await recall(db, null, 'Lisbon', { mode: 'lex' });
  const rows = db.prepare(`SELECT query_hash FROM recall_log`).all() as Array<{
    query_hash: string;
  }>;
  assert.equal(rows.length, 2);
  assert.equal(rows[0].query_hash, rows[1].query_hash);
  closeDb(db);
});

test('recall: vec mode finds the row whose embedding the dispatcher returned', async () => {
  // ingest no longer embeds inline (deferred to the embedder job), so this test
  // writes the vector directly into events_content + events_vec to set up the recall
  // surface, then verifies vec recall works against the seeded data.
  const db = freshDb();
  const targetVec = new Array(3072).fill(0.0);
  targetVec[0] = 1.0;
  const llm = mockLLM(targetVec);
  const r = ingest(db, llm, {
    kind: 't',
    source: 's',
    content: 'kevin loves photography in Lisbon',
  });
  assert.ok(r.contentId);
  const buf = Buffer.from(new Float32Array(targetVec).buffer);
  db.prepare('UPDATE events_content SET embedding = ? WHERE id = ?').run(buf, r.contentId);
  // vec0 requires BigInt rowid binding (rejects JS Number with "only integers allowed").
  db.prepare('INSERT INTO events_vec(rowid, embedding) VALUES (?, ?)').run(
    BigInt(r.contentId),
    buf,
  );

  const hits = await recall(db, llm, 'unrelated query', { mode: 'vec' });
  assert.equal(hits.length, 1);
  assert.match(hits[0].body, /Lisbon/);
  closeDb(db);
});
