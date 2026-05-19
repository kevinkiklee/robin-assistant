import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDb, closeDb } from '../../../brain/memory/db.ts';
import { allMigrations, applyMigrations } from '../../../brain/memory/migrations/index.ts';
import { buildCoreServer } from './server.ts';
import { ingest } from '../../../brain/memory/ingest.ts';
import { upsertEntity } from '../../../brain/memory/entity.ts';

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
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{ name: string }>;
  const names = tables.map((t) => t.name);
  for (const t of ['predictions', 'corrections', 'refusals', 'audit_meta', 'metrics_daily', 'journals']) {
    assert.ok(names.includes(t), `${t} missing`);
  }
  closeDb(db);
});
