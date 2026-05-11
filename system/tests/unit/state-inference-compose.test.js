import assert from 'node:assert/strict';
import { mkdirSync as __mk } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { composeForSource } from '../../cognition/jobs/internal/state-inference.js';
import { noteStateInference } from '../../cognition/memory/state_inference.js';
import * as store from '../../cognition/memory/store.js';
import { writeConfig } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';
import { createStubEmbedder } from '../../data/embed/embedder.js';

const HOME = join(tmpdir(), `robin-cmp-${process.pid}-${Math.random().toString(36).slice(2)}`);
__mk(HOME, { recursive: true });
process.env.ROBIN_HOME = HOME;
await writeConfig({ embedder_profile: 'mxbai-1024' });

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../data/db/migrations'));
  return db;
}

/**
 * Shared fixture helper — seeds a biographed event with mentions edges and an
 * optional episode link. `record-event.js`'s VALID_SOURCES set only accepts
 * a small enum (`'conversation'` is the closest match for an agent-transcript
 * event); it also drops `episode_id`, `entity_refs`, and `biographed_at` from
 * the input, so this helper bypasses it with raw SurrealQL.
 */
async function seedBiographedEvent(db, embedder, {
  source = 'conversation',
  content,
  entities = [],
  episodeId = null,
}) {
  const [created] = await db
    .query(
      surql`CREATE events CONTENT ${{
        source,
        content,
        biographed_at: new Date(),
      }}`,
    )
    .collect();
  const row = Array.isArray(created) ? created[0] : created;
  const eventId = row.id;
  if (episodeId) {
    await db
      .query(surql`UPDATE ${eventId} SET episode_id = ${episodeId}`)
      .collect();
  }
  for (const entId of entities) {
    // Use store.relate to wire mentions into the canonical `edges` relation
    // table (attention.js queries `edges WHERE kind='mentions'`, not a
    // standalone `mentions` table).
    await store.relate(db, eventId, entId, 'mentions');
  }
  return { id: eventId };
}

async function seedEpisode(db, source = 'conversation') {
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
  return epRows[0].id;
}

function makeLLMMock(response) {
  let calls = 0;
  return {
    invokeLLM: async () => {
      calls++;
      return {
        content: JSON.stringify(response),
        usage: { input_tokens: 200, output_tokens: 60 },
      };
    },
    get calls() {
      return calls;
    },
  };
}

const TEST_SOURCE = 'conversation';

const CFG = {
  enabled: 'shadow', // 'shadow' runs the pipeline but suppresses the memo write
  tick_ms: 300000,
  attention_window_min: 90,
  refresh_after_minutes: 30,
  min_events_for_inference: 2,
  max_sources_per_tick: 4,
  min_confidence_to_surface: 0.5,
  stale_after_minutes: 120,
  pivot_weight: 1.0,
  corroborate_weight: 1.0,
};

test('U1 — empty attention → no write', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  const llm = makeLLMMock({ focus_statement: 'x', confidence: 0.7, evidence_snippet: '', ambiguous: false, drop: false });
  const r = await composeForSource({
    db,
    embedder: e,
    host: llm,
    source: TEST_SOURCE,
    cfg: { ...CFG, enabled: true },
    now: new Date(),
  });
  assert.equal(r.outcome, 'dropped_thin');
  assert.equal(llm.calls, 0);
  await close(db);
});

test('U2 — no change → no LLM call, no write', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  // Seed: one episode, one entity, one biographed event linking the two via
  // the production mentions edge, then a prior inference whose signal_hash
  // matches the upcoming computation (entities=[ent.id], arc_id=null,
  // last_event_id=<the event we just created>).
  const epId = await seedEpisode(db);
  const ent = await store.upsertEntity(db, e, { type: 'topic', name: 'cognition' });
  const { id: evId } = await seedBiographedEvent(db, e, {
    source: TEST_SOURCE,
    content: 'iterating',
    entities: [ent.id],
    episodeId: epId,
  });
  const { computeSignalHash } = await import('../../cognition/jobs/internal/state-inference.js');
  const priorSig = computeSignalHash({
    entities: [ent.id],
    arc_id: null,
    last_event_id: evId,
  });
  await noteStateInference(db, e, {
    source: TEST_SOURCE,
    content: 'prior',
    confidence: 0.7,
    entities: [ent.id],
    last_event_id: evId,
    last_active_at: new Date(),
    signal_hash: priorSig,
  });
  const llm = makeLLMMock({ focus_statement: 'x', confidence: 0.7, evidence_snippet: '', ambiguous: false, drop: false });
  const r = await composeForSource({
    db,
    embedder: e,
    host: llm,
    source: TEST_SOURCE,
    cfg: { ...CFG, enabled: true },
    now: new Date(),
  });
  assert.equal(r.outcome, 'skipped_unchanged');
  assert.equal(llm.calls, 0, 'steady state: zero LLM invocations');
  await close(db);
});

test('U3 — entity-set change → LLM call, new memo, supersedes edge', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  const epId = await seedEpisode(db);
  const entA = await store.upsertEntity(db, e, { type: 'topic', name: 'A' });
  const entB = await store.upsertEntity(db, e, { type: 'topic', name: 'B' });
  // Prior inference with entities=[A], stale signal_hash.
  await noteStateInference(db, e, {
    source: TEST_SOURCE,
    content: 'about A',
    confidence: 0.7,
    entities: [entA.id],
    last_active_at: new Date(),
    signal_hash: 'stale-hash',
  });
  // Current event tied to entB → entity set changes.
  await seedBiographedEvent(db, e, {
    source: TEST_SOURCE,
    content: 'now B',
    entities: [entB.id],
    episodeId: epId,
  });
  const llm = makeLLMMock({
    focus_statement: 'Working on B',
    confidence: 0.8,
    evidence_snippet: 'now B',
    ambiguous: false,
    drop: false,
  });
  const r = await composeForSource({
    db,
    embedder: e,
    host: llm,
    source: TEST_SOURCE,
    cfg: { ...CFG, enabled: true },
    now: new Date(),
  });
  assert.equal(r.outcome, 'wrote');
  assert.equal(llm.calls, 1);
  // supersedes edge from new → prior (lives on the unified `edges` table).
  const [edges] = await db
    .query(`SELECT count() AS n FROM edges WHERE kind = 'supersedes' GROUP ALL`)
    .collect();
  assert.equal(edges?.[0]?.n ?? 0, 1);
  await close(db);
});

test('U4 — LLM drop=true → no write, telemetry dropped_thin', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  const epId = await seedEpisode(db);
  const ent = await store.upsertEntity(db, e, { type: 'topic', name: 'x' });
  await seedBiographedEvent(db, e, {
    source: TEST_SOURCE,
    content: 'something',
    entities: [ent.id],
    episodeId: epId,
  });
  const llm = makeLLMMock({
    focus_statement: '',
    confidence: 0.1,
    evidence_snippet: '',
    ambiguous: true,
    drop: true,
  });
  const r = await composeForSource({
    db,
    embedder: e,
    host: llm,
    source: TEST_SOURCE,
    cfg: { ...CFG, enabled: true },
    now: new Date(),
  });
  assert.equal(r.outcome, 'dropped_thin');
  const [memos] = await db
    .query(`SELECT count() AS n FROM memos WHERE kind = 'state_inference' GROUP ALL`)
    .collect();
  assert.equal(memos?.[0]?.n ?? 0, 0);
  await close(db);
});

test('U5 — confidence clamping (1.5 → 0.95; -0.3 → 0.05; ambiguous 0.8 → 0.4)', async () => {
  const { clampConfidence } = await import('../../cognition/jobs/internal/state-inference.js');
  assert.equal(clampConfidence(1.5, false), 0.95);
  assert.equal(clampConfidence(-0.3, false), 0.05);
  assert.equal(clampConfidence(0.8, true), 0.4);
});

test('U6 — entity scope=private → new memo inherits scope=private', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  const epId = await seedEpisode(db);
  const ent = await store.upsertEntity(db, e, { type: 'topic', name: 'secret', scope: 'private' });
  await seedBiographedEvent(db, e, {
    source: TEST_SOURCE,
    content: 'hush',
    entities: [ent.id],
    episodeId: epId,
  });
  const llm = makeLLMMock({
    focus_statement: 'Working on secret',
    confidence: 0.8,
    evidence_snippet: 'hush',
    ambiguous: false,
    drop: false,
  });
  await composeForSource({
    db,
    embedder: e,
    host: llm,
    source: TEST_SOURCE,
    cfg: { ...CFG, enabled: true },
    now: new Date(),
  });
  const [memos] = await db
    .query(`SELECT scope FROM memos WHERE kind = 'state_inference' LIMIT 1`)
    .collect();
  assert.equal(memos?.[0]?.scope, 'private');
  await close(db);
});
