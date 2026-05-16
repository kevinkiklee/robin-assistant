import assert from 'node:assert/strict';
import { mkdirSync as __mk } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { intuitionEndpoint } from '../../cognition/intuition/inject.js';
import {
  _clearStateInferenceConfigCache,
  composeForSource,
  evaluateStateInference,
} from '../../cognition/jobs/internal/state-inference.js';
import { noteStateInference } from '../../cognition/memory/state_inference.js';
import * as store from '../../cognition/memory/store.js';
import { writeConfig } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';
import { createStubEmbedder } from '../../data/embed/embedder.js';

const HOME = join(tmpdir(), `robin-int-${process.pid}-${Math.random().toString(36).slice(2)}`);
__mk(HOME, { recursive: true });
process.env.ROBIN_HOME = HOME;
await writeConfig({ embedder_profile: 'mxbai-1024' });

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../data/db/migrations'));
  return db;
}

async function setEnabled(db, value) {
  await db
    .query(`UPDATE runtime:\`state_inference.config\` SET value.enabled = $v`, { v: value })
    .collect();
  // Bust the module-level 5s cfg cache so subsequent intuition/compose calls
  // in this test see the new value.
  _clearStateInferenceConfigCache();
}

const TEST_SOURCE = 'conversation';

async function seedBiographedEvent(
  db,
  _embedder,
  { source = TEST_SOURCE, content, entities = [], episodeId = null },
) {
  const [created] = await db
    .query(surql`CREATE events CONTENT ${{ source, content, biographed_at: new Date() }}`)
    .collect();
  const row = Array.isArray(created) ? created[0] : created;
  const eventId = row.id;
  if (episodeId) {
    await db.query(surql`UPDATE ${eventId} SET episode_id = ${episodeId}`).collect();
  }
  for (const entId of entities) {
    await store.relate(db, eventId, entId, 'mentions');
  }
  return { id: eventId };
}

async function seedSource(db, e, { source = TEST_SOURCE, entities = ['cognition'] } = {}) {
  await db
    .query(
      surql`CREATE episodes CONTENT ${{
        source,
        started_at: new Date(Date.now() - 5 * 60_000),
        last_event_at: new Date(),
      }}`,
    )
    .collect();
  const [epRows] = await db
    .query(surql`SELECT id FROM episodes WHERE source = ${source} LIMIT 1`)
    .collect();
  const entRefs = [];
  for (const name of entities) {
    const ent = await store.upsertEntity(db, e, { type: 'topic', name });
    entRefs.push(ent.id);
  }
  await seedBiographedEvent(db, e, {
    source,
    content: 'event content',
    entities: entRefs,
    episodeId: epRows[0].id,
  });
  return { epId: epRows[0].id, entRefs };
}

function makeHost(focusStatement, confidence = 0.8, drop = false) {
  return {
    invokeLLM: async () => ({
      content: JSON.stringify({
        focus_statement: focusStatement,
        confidence,
        evidence_snippet: 'snippet',
        ambiguous: false,
        drop,
      }),
      usage: { input_tokens: 200, output_tokens: 60 },
    }),
  };
}

function makeCountingHost(focusStatement, confidence = 0.8, drop = false) {
  const inner = makeHost(focusStatement, confidence, drop);
  let calls = 0;
  return {
    invokeLLM: async (...args) => {
      calls++;
      return inner.invokeLLM(...args);
    },
    get calls() {
      return calls;
    },
  };
}

const QUERY = 'how is the cognition work going?';

test('I1 — write → recall surfaces the focus block', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  await setEnabled(db, true);
  await seedSource(db, e);
  await composeForSource({
    db,
    embedder: e,
    host: makeHost('Alice is refactoring the cognition layer'),
    source: TEST_SOURCE,
    cfg: {
      enabled: true,
      attention_window_min: 90,
      refresh_after_minutes: 30,
      min_events_for_inference: 1,
      max_sources_per_tick: 4,
      min_confidence_to_surface: 0.5,
      stale_after_minutes: 120,
    },
  });
  const r = await intuitionEndpoint({
    db,
    embedder: e,
    query: QUERY,
    source: TEST_SOURCE,
  });
  assert.match(r.focus_block, /<!-- current focus -->/);
  assert.match(r.focus_block, /Alice is refactoring the cognition layer/);
  assert.match(r.focus_block, /last active 0m ago/);
  assert.ok(r.focus_tokens > 0);
  await close(db);
});

test('I2 — low confidence → suppressed', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  await setEnabled(db, true);
  await noteStateInference(db, e, {
    source: TEST_SOURCE,
    content: 'low conf focus',
    confidence: 0.3,
    entities: [],
    last_active_at: new Date(),
    signal_hash: 's',
  });
  const r = await intuitionEndpoint({
    db,
    embedder: e,
    query: QUERY,
    source: TEST_SOURCE,
  });
  assert.equal(r.focus_block, '');
  assert.equal(r.focus_suppressed_reason, 'low_confidence');
  await close(db);
});

test('I3 — stale → suppressed', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  await setEnabled(db, true);
  await noteStateInference(db, e, {
    source: TEST_SOURCE,
    content: 'stale focus',
    confidence: 0.8,
    entities: [],
    last_active_at: new Date(Date.now() - 4 * 3_600_000),
    signal_hash: 's',
  });
  const r = await intuitionEndpoint({
    db,
    embedder: e,
    query: QUERY,
    source: TEST_SOURCE,
  });
  assert.equal(r.focus_suppressed_reason, 'stale');
  await close(db);
});

test('I4 — pivot (zero keyword overlap) → suppressed', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  await setEnabled(db, true);
  // upsert a real entity ref so noteStateInference can wire about-edges
  const ent = await store.upsertEntity(db, e, { type: 'topic', name: 'cognition_refactor' });
  await noteStateInference(db, e, {
    source: TEST_SOURCE,
    content: 'Alice is refactoring cognition',
    confidence: 0.8,
    entities: [ent.id],
    last_active_at: new Date(),
    signal_hash: 's',
  });
  const r = await intuitionEndpoint({
    db,
    embedder: e,
    query: 'lunch plans tomorrow',
    source: TEST_SOURCE,
  });
  assert.equal(r.focus_suppressed_reason, 'pivot');
  await close(db);
});

test('I5 — superseded chain: latestForSource returns B, not A', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  await setEnabled(db, true);
  const ent = await store.upsertEntity(db, e, { type: 'topic', name: 'cognition' });
  // Content has substantive words so the pivot-suppression keyword check
  // (length>3 tokens) sees an overlap with the query.
  const a = await noteStateInference(db, e, {
    source: TEST_SOURCE,
    content: 'older focus before cognition pivot',
    confidence: 0.8,
    entities: [ent.id],
    last_active_at: new Date(),
    signal_hash: 'h1',
  });
  const b = await noteStateInference(db, e, {
    source: TEST_SOURCE,
    content: 'newer focus on cognition refactor',
    confidence: 0.8,
    entities: [ent.id],
    last_active_at: new Date(),
    signal_hash: 'h2',
  });
  await store.supersede(db, a.id, b.id);
  const r = await intuitionEndpoint({
    db,
    embedder: e,
    query: 'cognition status update',
    source: TEST_SOURCE,
  });
  assert.match(r.focus_block, /newer focus on cognition refactor/);
  assert.doesNotMatch(r.focus_block, /older focus before/);
  await close(db);
});

test('I6 — private memo → suppressed', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  await setEnabled(db, true);
  const ent = await store.upsertEntity(db, e, { type: 'topic', name: 'secret', scope: 'private' });
  await noteStateInference(db, e, {
    source: TEST_SOURCE,
    content: 'secret',
    confidence: 0.9,
    entities: [ent.id],
    last_active_at: new Date(),
    signal_hash: 'p',
    scope: 'private',
  });
  const r = await intuitionEndpoint({
    db,
    embedder: e,
    query: 'something secret related',
    source: TEST_SOURCE,
  });
  assert.equal(r.focus_suppressed_reason, 'private');
  await close(db);
});

test('I8 — cfg.enabled=false → evaluate skips, intuition skips block', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  // Explicit false: the rollout migrations 0013/0014 (also in this branch)
  // pre-flip the seed to 'shadow'/true, so we set the value back to test the
  // disabled gate path.
  await setEnabled(db, false);
  await seedSource(db, e);
  const host = makeHost('should never write');
  const r1 = await evaluateStateInference({ db, host, embedder: e });
  assert.equal(r1.outcome, 'skipped_disabled');
  const r2 = await intuitionEndpoint({
    db,
    embedder: e,
    query: QUERY,
    source: TEST_SOURCE,
  });
  assert.equal(r2.focus_suppressed_reason, 'disabled');
  await close(db);
});

test('I9 — shadow mode: pipeline runs, no memo written, focus block suppressed', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  await setEnabled(db, 'shadow');
  await seedSource(db, e);
  const host = makeHost('would-be focus');
  await evaluateStateInference({ db, host, embedder: e });
  // No memos written.
  const [memos] = await db
    .query(`SELECT count() AS n FROM memos WHERE kind = 'state_inference' GROUP ALL`)
    .collect();
  assert.equal(memos?.[0]?.n ?? 0, 0);
  // Telemetry rows exist.
  const [tel] = await db
    .query(`SELECT count() AS n FROM state_inference_telemetry GROUP ALL`)
    .collect();
  assert.ok((tel?.[0]?.n ?? 0) > 0);
  // Intuition path suppresses (rule 1 — 'shadow' is not literal true).
  const r = await intuitionEndpoint({
    db,
    embedder: e,
    query: QUERY,
    source: TEST_SOURCE,
  });
  assert.equal(r.focus_suppressed_reason, 'disabled');
  await close(db);
});

test('E1 — end-to-end: event → compose → recall surfaces; token count under cap', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  await setEnabled(db, true);
  await seedSource(db, e, { entities: ['cognition'] });
  const composed = await composeForSource({
    db,
    embedder: e,
    host: makeHost('Alice is iterating on the cognition layer refactor'),
    source: TEST_SOURCE,
    cfg: {
      enabled: true,
      attention_window_min: 90,
      refresh_after_minutes: 30,
      min_events_for_inference: 1,
      max_sources_per_tick: 4,
      min_confidence_to_surface: 0.5,
      stale_after_minutes: 120,
    },
  });
  assert.equal(composed.outcome, 'wrote', `compose did not write: ${JSON.stringify(composed)}`);
  const r = await intuitionEndpoint({
    db,
    embedder: e,
    query: 'cognition work',
    source: TEST_SOURCE,
  });
  assert.match(r.focus_block, /Alice is iterating on the cognition layer refactor/);
  assert.ok(r.focus_tokens <= 200, `expected focus_tokens ≤ 200, got ${r.focus_tokens}`);
  await close(db);
});

test('E2 — concurrent ticks within the same window are idempotent (zero LLM calls on rerun)', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  await setEnabled(db, true);
  await seedSource(db, e, { entities: ['cognition'] });
  const cfg = {
    enabled: true,
    attention_window_min: 90,
    refresh_after_minutes: 30,
    min_events_for_inference: 1,
    max_sources_per_tick: 4,
    min_confidence_to_surface: 0.5,
    stale_after_minutes: 120,
  };
  // First tick: counting host wraps the LLM call; we expect exactly one call.
  const firstHost = makeCountingHost('first');
  await composeForSource({
    db,
    embedder: e,
    host: firstHost,
    source: TEST_SOURCE,
    cfg,
  });
  assert.equal(firstHost.calls, 1, 'first tick: one LLM call');
  // Second tick: same inputs ⇒ same signal_hash ⇒ skipped_unchanged ⇒
  // the steady-state-no-LLM-call invariant requires zero invocations.
  const secondHost = makeCountingHost('would-be-second');
  const r = await composeForSource({
    db,
    embedder: e,
    host: secondHost,
    source: TEST_SOURCE,
    cfg,
  });
  assert.equal(r.outcome, 'skipped_unchanged');
  assert.equal(secondHost.calls, 0, 'second tick: zero LLM calls when nothing changed');
  const [memos] = await db
    .query(`SELECT count() AS n FROM memos WHERE kind = 'state_inference' GROUP ALL`)
    .collect();
  assert.equal(memos?.[0]?.n ?? 0, 1);
  await close(db);
});
