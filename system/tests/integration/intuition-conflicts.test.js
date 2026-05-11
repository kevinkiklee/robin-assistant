import assert from 'node:assert/strict';
import { mkdirSync as __robinMkdirSync } from 'node:fs';
import { tmpdir as __robinTmpdir } from 'node:os';
import { join as __robinJoin, resolve } from 'node:path';
import { test } from 'node:test';
import { intuitionEndpoint } from '../../cognition/intuition/inject.js';
import * as store from '../../cognition/memory/store.js';
import { writeConfig as __robinWriteConfig } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';
import { createStubEmbedder } from '../../data/embed/embedder.js';

const __robinTestHome = __robinJoin(
  __robinTmpdir(),
  `robin-test-${process.pid}-${Math.random().toString(36).slice(2)}`,
);
__robinMkdirSync(__robinTestHome, { recursive: true });
process.env.ROBIN_HOME = __robinTestHome;
await __robinWriteConfig({ embedder_profile: 'mxbai-1024' });

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../data/db/migrations'));
  await db.query('UPDATE runtime:recall SET value.conflict_surfacing_enabled = true').collect();
  // Bust the module-level recall-config cache so each test sees its own DB
  // and any UPDATEs made post-migration.
  store._resetRecallConfigCache();
  return db;
}

const e = createStubEmbedder({ dimension: 1024 });

// ---------------------------------------------------------------------------
// Task 3.2 keystone: contradicting pair surfaces and contraPenalty fires.
// ---------------------------------------------------------------------------

test('B2 §8.3 #12: contradicting pair -> conflict block + contraPenalty wired', async () => {
  const db = await fresh();
  const a = await store.note(db, e, 'knowledge', {
    content: 'primary bank is Chase as of 2026-05-02',
    derived_by: 'manual',
  });
  const b = await store.note(db, e, 'knowledge', {
    content: 'switched primary bank to Mercury 2026-04-12',
    derived_by: 'manual',
  });
  await store.flagContradiction(db, a.id, b.id);

  const result = await intuitionEndpoint({
    db,
    embedder: e,
    detector: null,
    query: 'what bank am I using',
    priorAssistant: '',
    k: 6,
    recencyDays: 30,
    tokenBudget: 1500,
    conflictTokenBudget: 300,
  });

  // Conflict block emitted.
  assert.ok(result.block.includes('<!-- conflicts -->'), 'conflicts marker present');
  assert.ok(result.block.includes('<!-- /conflicts -->'), 'closing marker present');
  assert.ok(result.block.includes(' <-> '), 'pair line separator present');
  assert.ok(result.block.includes('<!-- relevant memory -->'));

  // Telemetry row carries the new fields.
  const [tel] = await db.query('SELECT * FROM intuition_telemetry').collect();
  assert.equal(tel[0].conflicts_surfaced, 1);
  assert.ok(tel[0].conflicts_block_tokens > 0);

  // recall_log.meta.conflicts_surfaced mirrored.
  const [rec] = await db.query('SELECT meta, ranked_hits FROM recall_log').collect();
  assert.equal(rec[0].meta.conflicts_surfaced, 1);

  // contraPenalty wired on BOTH score() callsites: persisted recall_log row
  // has contraPenalty < 1.0 for both memo hits.
  const memoHits = (rec[0].ranked_hits ?? []).filter((h) => h.kind === 'memo');
  assert.ok(memoHits.length >= 2);
  for (const h of memoHits) {
    assert.ok(
      h.score_components.contraPenalty < 1.0,
      `expected contraPenalty < 1 for ${h.record}, got ${h.score_components.contraPenalty}`,
    );
  }
  await close(db);
});

// ---------------------------------------------------------------------------
// Task 4.1 — §8.3 #13 no contradictions, flag-on
// ---------------------------------------------------------------------------

test('B2 §8.3 #13: no contradicts edge -> block omitted, flag-on still byte-clean', async () => {
  const db = await fresh();
  await store.note(db, e, 'knowledge', {
    content: 'unique fact about gardening',
    derived_by: 'manual',
  });
  const result = await intuitionEndpoint({
    db,
    embedder: e,
    detector: null,
    query: 'gardening',
    priorAssistant: '',
    k: 6,
    recencyDays: 30,
    tokenBudget: 1500,
    conflictTokenBudget: 300,
  });
  assert.ok(!result.block.includes('<!-- conflicts -->'));
  assert.ok(!result.block.includes('<!-- /conflicts -->'));
  const [tel] = await db.query('SELECT * FROM intuition_telemetry').collect();
  // Flag is on, so B2 telemetry fields ARE present and zero.
  assert.equal(tel[0].conflicts_surfaced, 0);
  assert.equal(tel[0].conflicts_block_tokens, 0);
  assert.equal(tel[0].conflicts_hydrated_precap, 0);
  assert.equal(tel[0].conflicts_hydrated_postcap, 0);
  assert.equal(tel[0].conflicts_hydration_capped, false);
  assert.equal(tel[0].conflicts_block_truncated, false);
  const [rec] = await db.query('SELECT meta FROM recall_log').collect();
  assert.equal(rec[0].meta.conflicts_surfaced, 0);
  await close(db);
});

// ---------------------------------------------------------------------------
// Task 4.2 — §8.3 #14 low-confidence suppression
// ---------------------------------------------------------------------------

test('B2 §8.3 #14: low-confidence pair suppressed; counter records the rule', async () => {
  const db = await fresh();
  const a = await store.note(db, e, 'knowledge', {
    content: 'fact A',
    derived_by: 'manual',
  });
  const b = await store.note(db, e, 'knowledge', {
    content: 'fact B opposite of A',
    derived_by: 'manual',
  });
  // Drop B's confidence below the 0.4 threshold.
  await db.query(`UPDATE ${b.id} SET confidence = 0.3`).collect();
  await store.flagContradiction(db, a.id, b.id);

  const result = await intuitionEndpoint({
    db,
    embedder: e,
    detector: null,
    query: 'fact',
    priorAssistant: '',
    k: 6,
    recencyDays: 30,
    tokenBudget: 1500,
    conflictTokenBudget: 300,
  });
  assert.ok(!result.block.includes('<!-- conflicts -->'));
  const [tel] = await db.query('SELECT * FROM intuition_telemetry').collect();
  assert.equal(tel[0].conflicts_surfaced, 0);
  assert.equal(tel[0].conflicts_suppressed_by_rule.low_confidence, 1);
  await close(db);
});

// ---------------------------------------------------------------------------
// Task 4.3 — §8.3 #15 out-of-view contradictor pulled in
// ---------------------------------------------------------------------------

test('B2 §8.3 #15: out-of-view contradictor surfaces in <!-- conflicts --> but not <!-- relevant memory -->', async () => {
  const db = await fresh();
  // Seed an in-view memo and an out-of-view contradictor. To force the
  // contradictor out of the relevant-memory block while keeping the
  // contradicts edge traversable, we tag the contradictor with a different
  // kind ('thread') so `searchMemos({ kind: 'knowledge' })` excludes it.
  // fetchContradictors traverses edges directly and hydrates by id — kind
  // doesn't filter that path.
  const hitMemo = await store.note(db, e, 'knowledge', {
    content: 'the moon is made of cheese',
    derived_by: 'manual',
  });
  const oldContradictor = await store.note(db, e, 'thread', {
    content: 'the moon is rock',
    derived_by: 'manual',
  });
  await store.flagContradiction(db, hitMemo.id, oldContradictor.id);

  const result = await intuitionEndpoint({
    db,
    embedder: e,
    detector: null,
    query: 'the moon is made of cheese',
    priorAssistant: '',
    k: 6,
    recencyDays: 30,
    tokenBudget: 1500,
    conflictTokenBudget: 300,
  });
  // The contradictor's content appears in the conflicts block.
  assert.ok(
    result.block.includes('the moon is rock'),
    'contradictor content surfaced in conflict block',
  );
  // It does NOT appear in the relevant-memory block (i.e., between the relevant-memory markers).
  const relIdx = result.block.indexOf('<!-- relevant memory -->');
  const relEnd = result.block.indexOf('<!-- /relevant memory -->');
  const relevantBlock = result.block.slice(relIdx, relEnd);
  assert.ok(!relevantBlock.includes('the moon is rock'));
  await close(db);
});

// ---------------------------------------------------------------------------
// Task 4.4 — §8.3 #16 private redaction
// ---------------------------------------------------------------------------

test('B2 §8.3 #16: one-side private -> redaction shape; redacted_one_side telemetry', async () => {
  const db = await fresh();
  const pub = await store.note(db, e, 'knowledge', {
    content: 'public claim about thing',
    scope: 'global',
    derived_by: 'manual',
  });
  const priv = await store.note(db, e, 'knowledge', {
    content: 'PRIVATESCOPECONTENT must not surface',
    scope: 'private',
    derived_by: 'manual',
  });
  await store.flagContradiction(db, pub.id, priv.id);

  const result = await intuitionEndpoint({
    db,
    embedder: e,
    detector: null,
    query: 'thing',
    priorAssistant: '',
    k: 6,
    recencyDays: 30,
    tokenBudget: 1500,
    conflictTokenBudget: 300,
  });
  assert.ok(result.block.includes('<!-- conflicts -->'));
  assert.ok(result.block.includes('<private memo redacted>'));
  // The private memo content must not appear in the conflicts block. The
  // relevant-memory block is filtered by scope independently by searchMemos.
  const confIdx = result.block.indexOf('<!-- conflicts -->');
  const confEnd = result.block.indexOf('<!-- /conflicts -->');
  const conflictsBlock = result.block.slice(confIdx, confEnd);
  assert.ok(!conflictsBlock.includes('PRIVATESCOPECONTENT'));
  const [tel] = await db.query('SELECT * FROM intuition_telemetry').collect();
  assert.equal(tel[0].conflicts_redacted_one_side, 1);
  await close(db);
});

// ---------------------------------------------------------------------------
// Task 4.5 — §8.3 #17 flag-off byte identity
// ---------------------------------------------------------------------------

test('B2 §8.3 #17: flag off + contradicts edge -> byte-identical to pre-B2', async () => {
  const db = await fresh();
  // Disable the flag (the file-level fresh() turned it on).
  await db.query('UPDATE runtime:recall SET value.conflict_surfacing_enabled = false').collect();
  store._resetRecallConfigCache();
  const a = await store.note(db, e, 'knowledge', {
    content: 'primary bank is Chase as of 2026-05-02',
    derived_by: 'manual',
  });
  const b = await store.note(db, e, 'knowledge', {
    content: 'switched primary bank to Mercury 2026-04-12',
    derived_by: 'manual',
  });
  await store.flagContradiction(db, a.id, b.id);

  const result = await intuitionEndpoint({
    db,
    embedder: e,
    detector: null,
    query: 'what bank am I using',
    priorAssistant: '',
    k: 6,
    recencyDays: 30,
    tokenBudget: 1500,
    conflictTokenBudget: 300,
  });
  // No conflicts markers anywhere.
  assert.ok(!result.block.includes('<!-- conflicts -->'));
  assert.ok(!result.block.includes('<!-- /conflicts -->'));
  // B2 telemetry fields absent (undefined) — flag-off row shape is unchanged.
  const [tel] = await db.query('SELECT * FROM intuition_telemetry').collect();
  assert.equal(tel[0].conflicts_surfaced, undefined);
  assert.equal(tel[0].conflicts_block_tokens, undefined);
  // recall_log.meta has no conflicts_surfaced key.
  const [rec] = await db.query('SELECT meta, ranked_hits FROM recall_log').collect();
  assert.equal(rec[0].meta.conflicts_surfaced, undefined);
  // contraPenalty === 1.0 on both memo hits — the wiring is gated together
  // with the surfacing.
  const memoHits = (rec[0].ranked_hits ?? []).filter((h) => h.kind === 'memo');
  for (const h of memoHits) {
    assert.equal(h.score_components.contraPenalty, 1.0);
  }
  await close(db);
});

// ---------------------------------------------------------------------------
// Task 4.6 — §8.3 #18 recall_log.meta shape across flag states
// ---------------------------------------------------------------------------

test('B2 §8.3 #18: recall_log.meta.conflicts_surfaced shape — present (0) when on/no-conflicts; absent when off', async () => {
  // Flag on, no conflicts -> present and 0.
  {
    const db = await fresh();
    await store.note(db, e, 'knowledge', {
      content: 'unique fact',
      derived_by: 'manual',
    });
    await intuitionEndpoint({
      db,
      embedder: e,
      detector: null,
      query: 'unique fact',
      priorAssistant: '',
      k: 6,
      recencyDays: 30,
      tokenBudget: 1500,
      conflictTokenBudget: 300,
    });
    const [rec] = await db.query('SELECT meta FROM recall_log').collect();
    assert.equal(rec[0].meta.conflicts_surfaced, 0);
    await close(db);
  }
  // Flag off -> field absent.
  {
    const db = await fresh();
    await db.query('UPDATE runtime:recall SET value.conflict_surfacing_enabled = false').collect();
    store._resetRecallConfigCache();
    await store.note(db, e, 'knowledge', {
      content: 'unique fact',
      derived_by: 'manual',
    });
    await intuitionEndpoint({
      db,
      embedder: e,
      detector: null,
      query: 'unique fact',
      priorAssistant: '',
      k: 6,
      recencyDays: 30,
      tokenBudget: 1500,
      conflictTokenBudget: 300,
    });
    const [rec] = await db.query('SELECT meta FROM recall_log').collect();
    assert.equal(rec[0].meta.conflicts_surfaced, undefined);
    await close(db);
  }
});

// ---------------------------------------------------------------------------
// Phase 5 Task 5.1 — all §6.1 telemetry fields land on intuition_telemetry
// ---------------------------------------------------------------------------

test('B2 telemetry: all §6.1 fields land on intuition_telemetry under the schema', async () => {
  const db = await fresh();
  const a = await store.note(db, e, 'knowledge', {
    content: 'claim X',
    derived_by: 'manual',
  });
  const b = await store.note(db, e, 'knowledge', {
    content: 'claim Y opposite of X',
    derived_by: 'manual',
  });
  await store.flagContradiction(db, a.id, b.id);
  await intuitionEndpoint({
    db,
    embedder: e,
    detector: null,
    query: 'claim X',
    priorAssistant: '',
    k: 6,
    recencyDays: 30,
    tokenBudget: 1500,
    conflictTokenBudget: 300,
  });
  const [tel] = await db.query('SELECT * FROM intuition_telemetry').collect();
  const row = tel[0];
  // Type assertions — all eight B2 fields must be the documented shapes.
  assert.equal(typeof row.conflicts_surfaced, 'number');
  assert.equal(typeof row.conflicts_block_tokens, 'number');
  assert.equal(typeof row.conflicts_hydrated_precap, 'number');
  assert.equal(typeof row.conflicts_hydrated_postcap, 'number');
  assert.equal(typeof row.conflicts_hydration_capped, 'boolean');
  assert.equal(typeof row.conflicts_suppressed_by_rule, 'object');
  assert.equal(typeof row.conflicts_redacted_one_side, 'number');
  assert.equal(typeof row.conflicts_block_truncated, 'boolean');
  // suppressed_by_rule sub-object has the documented keys (even if zero).
  for (const k of ['low_confidence', 'superseded', 'both_blocked', 'stale', 'capped']) {
    assert.equal(typeof row.conflicts_suppressed_by_rule[k], 'number', `key ${k} present`);
  }
  await close(db);
});
