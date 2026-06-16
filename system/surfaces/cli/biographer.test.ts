import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { captureSession } from '../../brain/cognition/capture.ts';
import { LLMDispatcher } from '../../brain/llm/dispatcher.ts';
import type { LLMProvider } from '../../brain/llm/types.ts';
import { closeDb, openDb } from '../../brain/memory/db.ts';
import { allMigrations, applyMigrations } from '../../brain/memory/migrations/index.ts';
import { runBiographerCliCore } from './biographer.ts';

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'robin-bio-cli-'));
  mkdirSync(join(dir, 'state', 'db'), { recursive: true });
  const db = openDb(join(dir, 'state', 'db', 'robin.sqlite'));
  applyMigrations(db, allMigrations);
  return db;
}

function mockLLM(extractJson: string): LLMDispatcher {
  const p: LLMProvider = {
    name: 'mock',
    capabilities: new Set(['reasoning']),
    meta: { contextWindow: 8000, inputPricePerM: 0, outputPricePerM: 0 },
    invoke: async () => ({
      text: extractJson,
      usage: { inputTokens: 0, outputTokens: 0 },
      costUsd: 0,
      latencyMs: 0,
      provider: 'mock',
    }),
  };
  const d = new LLMDispatcher();
  d.register('m', p);
  d.assign('reasoning', 'm');
  return d;
}

// A capture long enough to clear the biographer's 1000-char minimum (the CLI uses
// the production defaults, so a tiny session would be skipped before extraction).
// User-turn content is keyed on `id` so capture's user-hash dedup treats each as a
// distinct session rather than collapsing identical bodies into one.
async function captureLongSession(db: ReturnType<typeof freshDb>, id: string): Promise<void> {
  await captureSession(db, null, {
    sessionId: id,
    turns: [
      { role: 'user', content: `Tell me about my ${id} Lisbon trip. ${'context '.repeat(80)}` },
      {
        role: 'assistant',
        content: `Kevin visited Lisbon in March and really enjoyed the food. ${'detail '.repeat(80)}`,
      },
    ],
  });
}

const EXTRACTION = JSON.stringify({
  entities: [
    { type: 'person', name: 'Kevin', domain: 'identity' },
    { type: 'place', name: 'Lisbon', domain: 'travel' },
  ],
  relations: [{ subject: 'Kevin', predicate: 'visited', object: 'Lisbon' }],
});

test('biographer CLI: a real pass extracts and persists entities/relations', async () => {
  const db = freshDb();
  await captureLongSession(db, 's1');
  const report = await runBiographerCliCore(db, mockLLM(EXTRACTION), { limit: 5 });

  assert.equal(report.dryRun, false);
  assert.equal(report.processed, 1);
  assert.equal(report.entitiesCreated, 2);
  assert.equal(report.relationsCreated, 1);

  const entCount = (db.prepare('SELECT COUNT(*) AS c FROM entities').get() as { c: number }).c;
  assert.equal(entCount, 2, 'entities should be persisted on a real run');
  closeDb(db);
});

test('biographer CLI: --dry-run reports counts but writes nothing', async () => {
  const db = freshDb();
  await captureLongSession(db, 's1');
  const report = await runBiographerCliCore(db, mockLLM(EXTRACTION), { dryRun: true, limit: 5 });

  // The report still reflects what WOULD have been extracted.
  assert.equal(report.dryRun, true);
  assert.equal(report.processed, 1);
  assert.equal(report.entitiesCreated, 2);
  assert.equal(report.relationsCreated, 1);

  // …but the transaction was rolled back, so nothing persisted.
  const entCount = (db.prepare('SELECT COUNT(*) AS c FROM entities').get() as { c: number }).c;
  const relCount = (db.prepare('SELECT COUNT(*) AS c FROM relations').get() as { c: number }).c;
  const markerCount = (
    db.prepare("SELECT COUNT(*) AS c FROM events WHERE kind = 'biographer.extracted'").get() as {
      c: number;
    }
  ).c;
  assert.equal(entCount, 0, 'dry-run must not persist entities');
  assert.equal(relCount, 0, 'dry-run must not persist relations');
  assert.equal(markerCount, 0, 'dry-run must not persist the extracted marker');
  closeDb(db);
});

test('biographer CLI: --limit bounds how many sessions are processed', async () => {
  const db = freshDb();
  await captureLongSession(db, 's1');
  await captureLongSession(db, 's2');
  await captureLongSession(db, 's3');

  const report = await runBiographerCliCore(db, mockLLM(EXTRACTION), { limit: 1 });
  assert.equal(report.processed, 1, 'limit=1 should process exactly one session');

  // Two sessions remain unextracted (no marker yet).
  const remaining = (
    db
      .prepare(
        `SELECT COUNT(*) AS c FROM events
          WHERE kind = 'session.captured'
            AND id NOT IN (
              SELECT json_extract(payload, '$.source_event_id')
                FROM events WHERE kind = 'biographer.extracted'
            )`,
      )
      .get() as { c: number }
  ).c;
  assert.equal(remaining, 2, 'two sessions should still be pending');
  closeDb(db);
});

test('biographer CLI: no LLM dispatcher → reports nothing extracted', async () => {
  const db = freshDb();
  await captureLongSession(db, 's1');
  // null dispatcher: runBiographer finalizes with empty extraction, but the CLI
  // entrypoint guards against this; here we exercise the core with null directly.
  const report = await runBiographerCliCore(db, null, { dryRun: true, limit: 5 });
  assert.equal(report.entitiesCreated, 0);
  assert.equal(report.relationsCreated, 0);
  closeDb(db);
});
