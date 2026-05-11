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

const HOME = join(tmpdir(), `robin-cal-${process.pid}-${Math.random().toString(36).slice(2)}`);
__mk(HOME, { recursive: true });
process.env.ROBIN_HOME = HOME;
await writeConfig({ embedder_profile: 'mxbai-1024' });

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../data/db/migrations'));
  return db;
}

// Inlined copy of the fixture helper from `state-inference-compose.test.js`.
async function seedBiographedEvent(
  db,
  _embedder,
  { source = 'conversation', content, entities = [], episodeId = null },
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

const TEST_SOURCE = 'conversation';

const CFG = {
  enabled: true,
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

test('I7 — pivot emits state_inference_pivoted refute row', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  const epId = await seedEpisode(db);
  const entA = await store.upsertEntity(db, e, { type: 'topic', name: 'A' });
  const entB = await store.upsertEntity(db, e, { type: 'topic', name: 'B' });
  const prior = await noteStateInference(db, e, {
    source: TEST_SOURCE,
    content: 'about A',
    confidence: 0.8,
    entities: [entA.id],
    arc_id: 'arcs:01',
    last_active_at: new Date(),
    signal_hash: 'old',
  });
  await seedBiographedEvent(db, e, {
    source: TEST_SOURCE,
    content: 'new B',
    entities: [entB.id],
    episodeId: epId,
  });
  const host = {
    invokeLLM: async () => ({
      content: JSON.stringify({
        focus_statement: 'Working on B',
        confidence: 0.7,
        evidence_snippet: 'new B',
        ambiguous: false,
        drop: false,
      }),
      usage: { input_tokens: 200, output_tokens: 60 },
    }),
  };
  await composeForSource({ db, embedder: e, host, source: TEST_SOURCE, cfg: CFG });
  const [rows] = await db
    .query(`SELECT polarity, reason FROM evidence_ledger WHERE memo_id = $id`, {
      id: prior.id,
    })
    .collect();
  const refute = (rows ?? []).find(
    (r) => r.polarity === 'refutes' && r.reason === 'state_inference_pivoted',
  );
  assert.ok(refute, 'expected one state_inference_pivoted refute row');
  await close(db);
});

test('calibration is deduped — running composeForSource twice does not double-emit', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  const epId = await seedEpisode(db);
  const entA = await store.upsertEntity(db, e, { type: 'topic', name: 'A' });
  const entB = await store.upsertEntity(db, e, { type: 'topic', name: 'B' });
  const prior = await noteStateInference(db, e, {
    source: TEST_SOURCE,
    content: 'about A',
    confidence: 0.8,
    entities: [entA.id],
    arc_id: 'arcs:01',
    last_active_at: new Date(),
    signal_hash: 'old',
  });
  await seedBiographedEvent(db, e, {
    source: TEST_SOURCE,
    content: 'new B',
    entities: [entB.id],
    episodeId: epId,
  });
  // First tick: LLM drops → no write, but calibration row should still fire.
  const dropHost = {
    invokeLLM: async () => ({
      content: JSON.stringify({
        focus_statement: '',
        confidence: 0.1,
        evidence_snippet: '',
        ambiguous: true,
        drop: true,
      }),
    }),
  };
  await composeForSource({ db, embedder: e, host: dropHost, source: TEST_SOURCE, cfg: CFG });
  // Second tick: also drop. Dedup guard must prevent a second ledger row.
  await composeForSource({ db, embedder: e, host: dropHost, source: TEST_SOURCE, cfg: CFG });
  const [rows] = await db
    .query(
      `SELECT count() AS n FROM evidence_ledger
       WHERE memo_id = $id AND reason IN ['state_inference_pivoted','state_inference_held']
         AND ts > $prior_derived_at
       GROUP ALL`,
      { id: prior.id, prior_derived_at: prior.derived_at },
    )
    .collect();
  assert.equal(rows?.[0]?.n ?? 0, 1, 'expected exactly one post-derived calibration row');
  await close(db);
});
