import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { closeDb, openDb } from '../../../brain/memory/db.ts';
import { allMigrations, applyMigrations } from '../../../brain/memory/migrations/index.ts';
import { beliefEmbeddingsBoundedInvariant } from './belief-embeddings-bounded.ts';

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'robin-belief-emb-'));
  const db = openDb(join(dir, 'robin.sqlite'));
  applyMigrations(db, allMigrations);
  return db;
}

function insertCandidate(
  db: ReturnType<typeof freshDb>,
  topic: string,
  status: string,
  embedding: Buffer | null,
) {
  db.prepare(
    `INSERT INTO belief_candidates (topic, claim, status, embedding) VALUES (?, ?, ?, ?)`,
  ).run(topic, `claim for ${topic}`, status, embedding);
}

const blob = () => Buffer.alloc(64, 1);

test('beliefs.embeddings_bounded: ok below the byte ceiling', async () => {
  const db = freshDb();
  insertCandidate(db, 't1', 'promoted', blob());
  const inv = beliefEmbeddingsBoundedInvariant(db); // default 8MB ceiling
  assert.equal((await inv.check()).ok, true);
  closeDb(db);
});

test('beliefs.embeddings_bounded: warns above the ceiling, counts terminal rows only', async () => {
  const db = freshDb();
  insertCandidate(db, 'p1', 'promoted', blob());
  insertCandidate(db, 'r1', 'rejected', blob());
  insertCandidate(db, 'pending1', 'pending', blob()); // never counted
  const inv = beliefEmbeddingsBoundedInvariant(db, { warnBytes: 100 });
  const r = await inv.check();
  assert.equal(r.ok, false);
  assert.match(r.message ?? '', /2 resolved candidate rows/);
  closeDb(db);
});

test('beliefs.embeddings_bounded: repair nulls terminal embeddings, keeps pending + conflicted', async () => {
  const db = freshDb();
  insertCandidate(db, 'p1', 'promoted', blob());
  insertCandidate(db, 'r1', 'rejected', blob());
  insertCandidate(db, 'm1', 'merged', blob());
  insertCandidate(db, 'pend', 'pending', blob());
  insertCandidate(db, 'conf', 'conflicted', blob());
  const inv = beliefEmbeddingsBoundedInvariant(db, { warnBytes: 10 });
  await inv.repair?.();
  const kept = db
    .prepare(`SELECT topic FROM belief_candidates WHERE embedding IS NOT NULL ORDER BY topic`)
    .all() as Array<{ topic: string }>;
  assert.deepEqual(
    kept.map((k) => k.topic),
    ['conf', 'pend'],
  );
  assert.equal((await inv.check()).ok, true);
  closeDb(db);
});
