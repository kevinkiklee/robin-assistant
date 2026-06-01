import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { LLMDispatcher } from '../../brain/llm/dispatcher.ts';
import type { LLMProvider } from '../../brain/llm/types.ts';
import { closeDb, openDb } from '../../brain/memory/db.ts';
import { ingest } from '../../brain/memory/ingest.ts';
import { allMigrations, applyMigrations } from '../../brain/memory/migrations/index.ts';
import { recall } from '../../brain/memory/recall.ts';
import { runReindexCore } from '../../surfaces/cli/reindex.ts';

// End-to-end coverage of the remember/recall pipeline. The MCP `remember` tool calls
// ingest(); the MCP `recall` tool calls recall(). Between them sit the FTS5 trigger
// (instant) and the embedder job (async, deferred from ingest). This file walks
// every hop in one test so nothing can silently regress in isolation.

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'robin-pipeline-'));
  mkdirSync(join(dir, 'state', 'db'), { recursive: true });
  const db = openDb(join(dir, 'state', 'db', 'robin.sqlite'));
  applyMigrations(db, allMigrations);
  return db;
}

function mockEmbedLLM(vec: number[]): LLMDispatcher {
  const provider: LLMProvider = {
    name: 'mock-embed',
    capabilities: new Set(['embed']),
    meta: { contextWindow: 0, inputPricePerM: 0, outputPricePerM: 0 },
    invoke: async () => {
      throw new Error('embed-only mock');
    },
    embed: async (text) => {
      const inputs = Array.isArray(text) ? text : [text];
      return inputs.map(() => vec);
    },
  };
  const d = new LLMDispatcher();
  d.register('m', provider);
  d.assign('embed', 'm');
  return d;
}

test('pipeline: remember → ingest writes events + content + FTS index instantly', async () => {
  const db = freshDb();
  // What `remember` MCP tool does internally
  const r = ingest(db, null, {
    kind: 'memory.remember',
    source: 'mcp',
    content: 'Kevin shoots both color and B&W deliberately; the decision rule is articulated',
  });
  assert.ok(r.eventId);
  assert.ok(r.contentId);

  // FTS5 trigger fires on INSERT — lex recall should find it immediately
  const lexHits = await recall(db, null, 'color articulated', { mode: 'lex' });
  assert.ok(lexHits.length >= 1, 'lex recall should surface the row right after ingest');
  assert.match(lexHits[0].body, /Kevin/);

  // Embedding NOT yet computed — vec recall returns lex hits as fallback when LLM null
  // (mode resolves to 'lex' when no LLM). With an LLM but no embedding, vec returns 0.
  closeDb(db);
});

test('pipeline: embedder picks up content with NULL embedding and makes vec recall work', async () => {
  const db = freshDb();

  // Step 1: remember
  ingest(db, null, {
    kind: 'memory.remember',
    source: 'mcp',
    content: 'Kevin uses Lightroom + a custom vectorscope plugin for color grading',
  });

  // Pre-condition: content row has NULL embedding (deferred from ingest)
  const before = db.prepare(`SELECT embedding FROM events_content`).get() as {
    embedding: Buffer | null;
  };
  assert.equal(before.embedding, null);

  // Step 2: embedder runs (simulated with a fixed-vec mock LLM)
  const vec = new Array(3072).fill(0);
  vec[0] = 1;
  const llm = mockEmbedLLM(vec);
  const report = await runReindexCore(db, llm);
  assert.equal(report.embedded, 1, `expected 1 row embedded, report=${JSON.stringify(report)}`);
  assert.equal(report.failed, 0);

  // Step 3: vec recall now finds the row
  const hits = await recall(db, llm, 'arbitrary query — embedding match is set up', {
    mode: 'vec',
  });
  assert.equal(hits.length, 1);
  assert.match(hits[0].body, /vectorscope/);
  assert.equal(hits[0].source, 'vec');
  closeDb(db);
});

test('pipeline: hybrid mode merges lex and vec into one ranked list', async () => {
  const db = freshDb();
  // Two distinct memories
  ingest(db, null, { kind: 'memory.remember', source: 'mcp', content: 'Kevin shoots in Astoria' });
  ingest(db, null, { kind: 'memory.remember', source: 'mcp', content: 'Belgium pastoral 04-18' });

  // Same embedding for both rows so vec returns both
  const vec = new Array(3072).fill(0);
  vec[0] = 1;
  const llm = mockEmbedLLM(vec);
  const report = await runReindexCore(db, llm);
  assert.equal(report.embedded, 2);

  const hits = await recall(db, llm, 'Astoria', { mode: 'hybrid' });
  // Lex catches "Astoria"; vec returns both. Merged set has both with Astoria ranked higher
  // (it accumulates lex + vec score) than the Belgium row (vec only).
  assert.ok(hits.length >= 1);
  assert.match(hits[0].body, /Astoria/, 'lex+vec sum should rank Astoria first');
  closeDb(db);
});

test('pipeline: every recall call writes a recall_log row regardless of mode or hit count', async () => {
  const db = freshDb();
  ingest(db, null, { kind: 'memory.remember', source: 'mcp', content: 'a body' });

  await recall(db, null, 'a', { mode: 'lex' });
  await recall(db, null, 'something-with-fts5-special-chars', { mode: 'lex' });
  // Vec call also logs (fallback path under no-llm returns lex; with llm it's a real vec path).
  const vec = new Array(3072).fill(0);
  vec[0] = 1;
  const llm = mockEmbedLLM(vec);
  await runReindexCore(db, llm);
  await recall(db, llm, 'body', { mode: 'hybrid' });

  const logs = db
    .prepare(`SELECT result_count, outcome FROM recall_log ORDER BY id`)
    .all() as Array<{
    result_count: number;
    outcome: string;
  }>;
  assert.equal(logs.length, 3, `expected 3 recall_log rows, got ${logs.length}`);
  // Outcome is now set deterministically at log time: answered when hits were
  // returned, miss when none (no longer left stuck at 'pending').
  for (const l of logs) {
    assert.equal(l.outcome, l.result_count > 0 ? 'answered' : 'miss');
  }
  closeDb(db);
});

test('pipeline: ingest upsert path replaces embedding so vec stays current', async () => {
  const db = freshDb();
  // First ingest with external_id
  const r1 = ingest(db, null, {
    kind: 'photo.indexed',
    source: 'photos',
    content: 'DSC_5115 subway B&W cinematic ISO 20000',
    payload: { external_id: 'photos:Portfolio/DSC_5115.jpg' },
  });

  // Embed it
  const vec1 = new Array(3072).fill(0);
  vec1[0] = 1;
  const llm1 = mockEmbedLLM(vec1);
  await runReindexCore(db, llm1);

  // Second ingest with same external_id — upsert path; embedding should reset to NULL
  const r2 = ingest(db, null, {
    kind: 'photo.indexed',
    source: 'photos',
    content: 'DSC_5115 subway B&W cinematic ISO 20000 — updated critique text',
    payload: { external_id: 'photos:Portfolio/DSC_5115.jpg' },
  });
  assert.equal(r1.eventId, r2.eventId, 'upsert should reuse the same event row');

  const after = db.prepare(`SELECT embedding FROM events_content`).get() as {
    embedding: Buffer | null;
  };
  assert.equal(after.embedding, null, 'embedding should be cleared after upsert so it re-embeds');

  // Second pass of embedder picks it up
  const vec2 = new Array(3072).fill(0);
  vec2[1] = 1;
  const llm2 = mockEmbedLLM(vec2);
  const report = await runReindexCore(db, llm2);
  assert.equal(report.embedded, 1);
  closeDb(db);
});
