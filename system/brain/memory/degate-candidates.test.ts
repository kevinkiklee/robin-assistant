import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { LLMDispatcher } from '../llm/dispatcher.ts';
import type { LLMProvider } from '../llm/types.ts';
import { closeDb, openDb } from './db.ts';
import { degateCandidates } from './degate-candidates.ts';
import { allMigrations, applyMigrations } from './migrations/index.ts';

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'robin-degate-'));
  mkdirSync(join(dir, 'state', 'db'), { recursive: true });
  const db = openDb(join(dir, 'state', 'db', 'robin.sqlite'));
  applyMigrations(db, allMigrations);
  return db;
}

/** Build a mock LLMDispatcher whose 'reasoning' invoke always returns `text`. */
function mockInvokeLlm(text: string): LLMDispatcher {
  const provider: LLMProvider = {
    name: 'mock',
    capabilities: new Set(['reasoning']),
    meta: { contextWindow: 8192, inputPricePerM: 0, outputPricePerM: 0 },
    invoke: async () => ({
      text,
      usage: { inputTokens: 0, outputTokens: 0 },
      costUsd: 0,
      latencyMs: 0,
      provider: 'mock',
    }),
  };
  const d = new LLMDispatcher();
  d.register('mock', provider);
  d.assign('reasoning', 'mock');
  return d;
}

/** Insert a candidate bypassing the low-quality filter (direct SQL). */
function rawInsert(
  db: ReturnType<typeof freshDb>,
  topic: string,
  claim: string,
  status: 'pending' | 'promoted' | 'rejected' = 'pending',
): number {
  const info = db
    .prepare(`INSERT INTO belief_candidates (topic, claim, status) VALUES (?, ?, ?)`)
    .run(topic, claim, status);
  return Number(info.lastInsertRowid);
}

test('deterministic pass culls a dev-artifact candidate, keeps a personal one (apply)', async () => {
  const db = freshDb();

  // A claim caught by isLowQualityClaim (mentions "MCP servers").
  const devId = rawInsert(db, 'robin-tools', 'Robin uses MCP servers to expose integrations.');
  // A clean personal fact (lives in Astoria — not caught by the filter).
  const personalId = rawInsert(db, 'location', 'Kevin lives in Astoria, Queens.');

  const result = await degateCandidates(db, null, { apply: true });

  assert.equal(result.scanned, 2);
  assert.equal(result.culled, 1);
  assert.equal(result.keptDeterministic, 1);
  assert.equal(result.llmClassified, 0);
  assert.equal(result.samples.length, 1);
  assert.equal(result.samples[0].id, devId);
  assert.equal(result.samples[0].reason, 'dev-artifact');

  const devRow = db
    .prepare(`SELECT status, resolved_reason FROM belief_candidates WHERE id = ?`)
    .get(devId) as { status: string; resolved_reason: string };
  assert.equal(devRow.status, 'rejected');
  assert.equal(devRow.resolved_reason, 'degate-engineering');

  const personalRow = db
    .prepare(`SELECT status FROM belief_candidates WHERE id = ?`)
    .get(personalId) as { status: string };
  assert.equal(personalRow.status, 'pending');

  closeDb(db);
});

test('dry-run writes nothing (both candidates stay pending)', async () => {
  const db = freshDb();

  const devId = rawInsert(db, 'robin-daemon', 'Robin runs as a launchd daemon on macOS.');
  const personalId = rawInsert(db, 'location', 'Kevin lives in Astoria, Queens.');

  // Default (no apply) → dry-run.
  const result = await degateCandidates(db, null);

  assert.equal(result.scanned, 2);
  assert.equal(result.culled, 1); // would-be count reported
  assert.equal(result.samples.length, 1);

  // No DB writes.
  const devRow = db.prepare(`SELECT status FROM belief_candidates WHERE id = ?`).get(devId) as {
    status: string;
  };
  assert.equal(devRow.status, 'pending');

  const personalRow = db
    .prepare(`SELECT status FROM belief_candidates WHERE id = ?`)
    .get(personalId) as { status: string };
  assert.equal(personalRow.status, 'pending');

  closeDb(db);
});

test('idempotent: a second apply run culls nothing new', async () => {
  const db = freshDb();

  rawInsert(db, 'robin-daemon', 'Robin uses MCP servers for integration actions.');
  rawInsert(db, 'location', 'Kevin lives in Astoria, Queens.');

  const first = await degateCandidates(db, null, { apply: true });
  assert.equal(first.culled, 1);

  // Second run: the dev candidate is already rejected; only the personal stays.
  const second = await degateCandidates(db, null, { apply: true });
  assert.equal(second.scanned, 1); // only the still-pending personal one
  assert.equal(second.culled, 0);
  assert.equal(second.keptDeterministic, 1);

  closeDb(db);
});

test('only acts on pending candidates (already-resolved rows untouched)', async () => {
  const db = freshDb();

  // A dev-artifact candidate that is ALREADY rejected — should not be touched again.
  const alreadyRejectedId = rawInsert(
    db,
    'robin-daemon',
    'Robin uses MCP servers for integration actions.',
    'rejected',
  );
  // A promoted candidate — also must not be touched.
  const promotedId = rawInsert(db, 'location', 'Kevin lives in Astoria, Queens.', 'promoted');

  const result = await degateCandidates(db, null, { apply: true });

  assert.equal(result.scanned, 0);
  assert.equal(result.culled, 0);

  // Confirm statuses unchanged.
  const rejRow = db
    .prepare(`SELECT status, resolved_reason FROM belief_candidates WHERE id = ?`)
    .get(alreadyRejectedId) as { status: string; resolved_reason: string | null };
  assert.equal(rejRow.status, 'rejected');
  assert.equal(rejRow.resolved_reason, null); // no degate-engineering tag added

  const proRow = db
    .prepare(`SELECT status FROM belief_candidates WHERE id = ?`)
    .get(promotedId) as { status: string };
  assert.equal(proRow.status, 'promoted');

  closeDb(db);
});

test('llm pass culls an engineering candidate the deterministic pass missed', async () => {
  const db = freshDb();

  // A claim that is NOT caught by isLowQualityClaim but is engineering by domain.
  // (Does not mention any of the regex keywords; ambiguous on its face.)
  const engId = rawInsert(
    db,
    'trading-integration',
    "Kevin's trading service integrates with the assistant via a REST API.",
  );
  // A personal finance fact the mock will classify as 'finance' — must be kept.
  const financeId = rawInsert(
    db,
    'portfolio',
    "Kevin's investment portfolio includes index funds and individual equities.",
  );

  // Mock: id=engId → 'engineering', id=financeId → 'finance'.
  // We can't predict the actual ids in the JSON, so we use a mock that returns
  // a response keyed on the ids we just inserted.
  const responseJson = JSON.stringify([
    { id: engId, domain: 'engineering' },
    { id: financeId, domain: 'finance' },
  ]);
  const llm = mockInvokeLlm(responseJson);

  const result = await degateCandidates(db, llm, { apply: true, useLlm: true });

  assert.equal(result.scanned, 2);
  assert.equal(result.culled, 1);
  assert.equal(result.llmClassified, 2);
  assert.equal(result.keptDeterministic, 1);
  assert.equal(result.samples[0].id, engId);
  assert.equal(result.samples[0].reason, 'llm:engineering');

  const engRow = db
    .prepare(`SELECT status, resolved_reason FROM belief_candidates WHERE id = ?`)
    .get(engId) as { status: string; resolved_reason: string };
  assert.equal(engRow.status, 'rejected');
  assert.equal(engRow.resolved_reason, 'degate-engineering');

  const finRow = db.prepare(`SELECT status FROM belief_candidates WHERE id = ?`).get(financeId) as {
    status: string;
  };
  assert.equal(finRow.status, 'pending');

  closeDb(db);
});

test('llm parse failure keeps all candidates (recall bias, never cull on uncertainty)', async () => {
  const db = freshDb();

  const id1 = rawInsert(
    db,
    'trading-integration',
    "Kevin's trading service integrates with the assistant via a REST API.",
  );

  // Mock returns invalid JSON.
  const llm = mockInvokeLlm('not valid json at all');
  const result = await degateCandidates(db, llm, { apply: true, useLlm: true });

  assert.equal(result.scanned, 1);
  assert.equal(result.culled, 0); // parse failure → keep
  assert.equal(result.llmClassified, 1);
  assert.equal(result.keptDeterministic, 1); // absent from failed-parse map → kept

  const row = db.prepare(`SELECT status FROM belief_candidates WHERE id = ?`).get(id1) as {
    status: string;
  };
  assert.equal(row.status, 'pending'); // untouched

  closeDb(db);
});
