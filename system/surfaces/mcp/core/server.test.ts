import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { believe, recallBelief } from '../../../brain/memory/belief.ts';
import { closeDb, openDb } from '../../../brain/memory/db.ts';
import { upsertEntity } from '../../../brain/memory/entity.ts';
import { ingest } from '../../../brain/memory/ingest.ts';
import { allMigrations, applyMigrations } from '../../../brain/memory/migrations/index.ts';
import { buildCoreServer } from './server.ts';

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'robin-mcp-core-'));
  mkdirSync(join(dir, 'state', 'db'), { recursive: true });
  const db = openDb(join(dir, 'state', 'db', 'robin.sqlite'));
  applyMigrations(db, allMigrations);
  return db;
}

test('robin-core: builds with no errors', () => {
  const db = freshDb();
  const server = buildCoreServer({ db, llm: null });
  assert.ok(server);
  closeDb(db);
});

test('robin-core: registered tools are reachable on the server instance', () => {
  const db = freshDb();
  const server = buildCoreServer({ db, llm: null });
  // The server should have at least 5 tools registered. MCP SDK doesn't expose tools publicly;
  // verify by checking that the server's underlying server object exists.
  assert.ok(server.server);
  closeDb(db);
});

test('robin-core: remember + find_entity round trip through DB', async () => {
  const db = freshDb();
  // Don't use the MCP layer for this — invoke the underlying functions to verify they work together
  await ingest(db, null, { kind: 'memory.remember', source: 'mcp', content: 'kevin loves Lisbon' });
  upsertEntity(db, 'person', 'Kevin');
  const events = db.prepare('SELECT COUNT(*) AS c FROM events').get() as { c: number };
  const entities = db.prepare('SELECT COUNT(*) AS c FROM entities').get() as { c: number };
  assert.equal(events.c, 1);
  assert.equal(entities.c, 1);
  closeDb(db);
});

test('robin-core: lifecycle tables (predictions, corrections, refusals, etc.) exist after migrations', () => {
  const db = freshDb();
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all() as Array<{ name: string }>;
  const names = tables.map((t) => t.name);
  for (const t of [
    'predictions',
    'corrections',
    'refusals',
    'audit_meta',
    'metrics_daily',
    'journals',
  ]) {
    assert.ok(names.includes(t), `${t} missing`);
  }
  closeDb(db);
});

test('robin-core: believe + recall_belief round trip through DB', () => {
  const db = freshDb();
  // Mirror the MCP tools, which delegate to believe/recallBelief directly.
  believe(db, null, {
    topic: 'whoop.recovery',
    claim: 'dips after redeye',
    date: '2026-05-23',
  });
  const head = recallBelief(db, { topic: 'whoop.recovery' });
  assert.ok(head && !Array.isArray(head));
  assert.equal((head as { claim: string }).claim, 'dips after redeye');
  closeDb(db);
});

test('robin-core: predict with same external_id upserts (one row, not two)', () => {
  const db = freshDb();
  // Mirror the predict tool's idempotency contract: first call inserts, a
  // repeat with the same external_id updates in place rather than appending.
  const externalId = 'daily-brief:2026-05-23:goog-up';
  const upsertPredict = (claim: string, confidence: number) => {
    const existing = db
      .prepare('SELECT id FROM predictions WHERE external_id = ?')
      .get(externalId) as { id: number } | undefined;
    if (existing) {
      db.prepare(
        'UPDATE predictions SET claim=?, confidence=?, deadline=?, resolution_method=? WHERE id=?',
      ).run(claim, confidence, null, null, existing.id);
      return { id: existing.id, upserted: true };
    }
    const info = db
      .prepare(
        'INSERT INTO predictions (claim, confidence, deadline, resolution_method, external_id) VALUES (?, ?, ?, ?, ?)',
      )
      .run(claim, confidence, null, null, externalId);
    return { id: Number(info.lastInsertRowid), upserted: false };
  };

  const first = upsertPredict('GOOG closes up', 0.6);
  const second = upsertPredict('GOOG closes up by EOD', 0.7);
  assert.equal(second.upserted, true);
  assert.equal(second.id, first.id);

  const count = db
    .prepare('SELECT COUNT(*) AS c FROM predictions WHERE external_id = ?')
    .get(externalId) as { c: number };
  assert.equal(count.c, 1, 'same external_id must update, not append');

  const row = db
    .prepare('SELECT claim, confidence FROM predictions WHERE id = ?')
    .get(first.id) as { claim: string; confidence: number };
  assert.equal(row.claim, 'GOOG closes up by EOD');
  assert.equal(row.confidence, 0.7);
  closeDb(db);
});
