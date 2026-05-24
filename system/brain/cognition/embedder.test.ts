import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { LLMDispatcher } from '../llm/dispatcher.ts';
import type { LLMProvider } from '../llm/types.ts';
import { closeDb, openDb } from '../memory/db.ts';
import { allMigrations, applyMigrations } from '../memory/migrations/index.ts';
import { runEmbedder } from './embedder.ts';

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'robin-backfill-'));
  mkdirSync(join(dir, 'state', 'db'), { recursive: true });
  const db = openDb(join(dir, 'state', 'db', 'robin.sqlite'));
  applyMigrations(db, allMigrations);
  return db;
}

function embedProvider(): LLMProvider {
  return {
    name: 'embed-mock',
    capabilities: new Set(['embed']),
    meta: { contextWindow: 0, inputPricePerM: 0, outputPricePerM: 0 },
    invoke: async () => {
      throw new Error('not used');
    },
    embed: async () => [new Array(4096).fill(0.1)],
  };
}

describe('embedder', () => {
  it('returns no-embed when no LLM dispatcher is provided', async () => {
    const db = freshDb();
    const r = await runEmbedder(db, null);
    assert.equal(r.status, 'no-embed');
    assert.equal(r.embedded, 0);
    closeDb(db);
  });

  it('returns no-embed when the embed role is missing', async () => {
    const db = freshDb();
    const llm = new LLMDispatcher(); // no providers registered
    const r = await runEmbedder(db, llm);
    assert.equal(r.status, 'no-embed');
    closeDb(db);
  });

  it('embeds NULL-embedding rows up to the batch ceiling', async () => {
    const db = freshDb();
    const ins = db.prepare(`INSERT INTO events_content (ts, body) VALUES (?, ?)`);
    for (let i = 0; i < 5; i++) ins.run('2026-05-19T00:00:00Z', `row-${i}`);

    const llm = new LLMDispatcher();
    llm.register('e', embedProvider());
    llm.assign('embed', 'e');

    const r = await runEmbedder(db, llm, 3);
    assert.equal(r.status, 'ok');
    assert.equal(r.embedded, 3);
    assert.equal(r.failed, 0);
    assert.equal(r.total_eligible, 3);

    // 2 rows still NULL, picked up next tick
    const remaining = db
      .prepare(`SELECT COUNT(*) AS c FROM events_content WHERE embedding IS NULL`)
      .get() as { c: number };
    assert.equal(remaining.c, 2);
    closeDb(db);
  });

  it('is a no-op when no rows need embedding', async () => {
    const db = freshDb();
    const llm = new LLMDispatcher();
    llm.register('e', embedProvider());
    llm.assign('embed', 'e');
    const r = await runEmbedder(db, llm);
    assert.equal(r.status, 'ok');
    assert.equal(r.embedded, 0);
    assert.equal(r.total_eligible, 0);
    closeDb(db);
  });
});
