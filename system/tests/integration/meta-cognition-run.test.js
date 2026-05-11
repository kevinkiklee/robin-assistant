import assert from 'node:assert/strict';
import { mkdirSync as __mk } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import runMetaRecallNarrative from '../../cognition/jobs/internal/meta-recall-narrative.js';
import { writeConfig } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';
import { createStubEmbedder } from '../../data/embed/embedder.js';

const HOME = join(tmpdir(), `robin-d2-${process.pid}-${Math.random().toString(36).slice(2)}`);
__mk(HOME, { recursive: true });
process.env.ROBIN_HOME = HOME;
await writeConfig({ embedder_profile: 'mxbai-1024' });

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../data/db/migrations'));
  return db;
}

function fakeHost(returnContent) {
  let calls = 0;
  return {
    invokeLLM: async () => {
      calls += 1;
      return { content: returnContent, usage: { input_tokens: 100, output_tokens: 200 } };
    },
    get calls() {
      return calls;
    },
  };
}

async function seedCorrected(db, n, opts = {}) {
  for (let i = 0; i < n; i++) {
    await db
      .query(
        surql`CREATE recall_log CONTENT {
        ts: time::now() - 1d,
        session_id: ${`s${i}`},
        query: ${`q${i}`},
        k: 5,
        ranked_hits: ${opts.hits ?? []},
        outcome: 'corrected',
      }`,
      )
      .collect();
  }
}

test('T1 — disabled flag short-circuits', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  await seedCorrected(db, 10);
  const result = await runMetaRecallNarrative({ db, embedder: e, host: fakeHost('{}') });
  const summary = JSON.parse(result);
  assert.equal(summary.ran, false);
  assert.equal(summary.reason, 'disabled');
  const [tel] = await db
    .query('SELECT outcome, ts FROM meta_cognition_telemetry ORDER BY ts DESC LIMIT 1')
    .collect();
  assert.equal(tel?.[0]?.outcome, 'skipped_disabled');
  await close(db);
});

test('T2 — below-threshold short-circuits even when enabled', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  await db.query('UPDATE runtime:`meta_cognition.config` SET value.enabled = true').collect();
  await seedCorrected(db, 3); // < default 5
  const result = await runMetaRecallNarrative({ db, embedder: e, host: fakeHost('{}') });
  const summary = JSON.parse(result);
  assert.equal(summary.ran, false);
  assert.equal(summary.reason, 'below_threshold');
  assert.equal(summary.corrected_count, 3);
  const [tel] = await db
    .query(
      'SELECT outcome, corrected_count, ts FROM meta_cognition_telemetry ORDER BY ts DESC LIMIT 1',
    )
    .collect();
  assert.equal(tel?.[0]?.outcome, 'skipped_below_threshold');
  assert.equal(tel?.[0]?.corrected_count, 3);
  await close(db);
});

test('T3 — corrected rows fetched within lookback_days', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  await db.query('UPDATE runtime:`meta_cognition.config` SET value.enabled = true').collect();
  // 5 within the window.
  await seedCorrected(db, 5);
  // 2 outside the window (8 days ago).
  for (let i = 0; i < 2; i++) {
    await db
      .query(
        surql`CREATE recall_log CONTENT {
        ts: time::now() - 8d,
        session_id: ${`old${i}`},
        query: ${`oq${i}`},
        k: 5,
        ranked_hits: [],
        outcome: 'corrected',
      }`,
      )
      .collect();
  }
  const result = await runMetaRecallNarrative({ db, embedder: e, host: fakeHost('{}') });
  const summary = JSON.parse(result);
  // No clusters because seedCorrected uses empty ranked_hits.
  assert.equal(summary.reason, 'no_clusters');
  const [tel] = await db
    .query(
      'SELECT outcome, corrected_count, rows_after_privacy, ts FROM meta_cognition_telemetry ORDER BY ts DESC LIMIT 1',
    )
    .collect();
  assert.equal(tel?.[0]?.outcome, 'no_clusters');
  // corrected_count from gate (5 within 7d), rows_after_privacy ≤ 5.
  assert.equal(tel?.[0]?.corrected_count, 5);
  assert.ok((tel?.[0]?.rows_after_privacy ?? 0) <= 5);
  await close(db);
});

test('T4 — shadow mode: clusters formed, no LLM call, no memo write', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  const { note } = await import('../../cognition/memory/store.js');
  const ent = await db
    .query(surql`CREATE entities CONTENT { name: 'photo-tools', type: 'project', scope: 'global' }`)
    .collect();
  const entityId = ent[0][0].id;

  // 5 memos all "about" the same entity.
  const memos = [];
  for (let i = 0; i < 5; i++) {
    const m = await note(db, e, 'knowledge', {
      content: `mem ${i}`,
      derived_by: 'agent',
      scope: 'global',
      subjects: [entityId],
    });
    memos.push(m.id);
  }
  // 5 corrected recall_log rows each hitting one of the memos.
  for (let i = 0; i < 5; i++) {
    await db
      .query(
        surql`CREATE recall_log CONTENT {
        ts: time::now() - 1d,
        session_id: ${`s${i}`},
        query: ${`q${i}`},
        k: 5,
        ranked_hits: [{ record: ${memos[i]}, kind: 'memo' }],
        outcome: 'corrected',
      }`,
      )
      .collect();
  }
  await db.query("UPDATE runtime:`meta_cognition.config` SET value.enabled = 'shadow'").collect();

  const host = fakeHost('{}');
  const result = await runMetaRecallNarrative({ db, embedder: e, host });
  const summary = JSON.parse(result);
  assert.equal(summary.ran, false);
  assert.equal(summary.reason, 'shadow_mode');
  assert.ok(summary.cluster_count >= 1);
  assert.equal(host.calls, 0, 'shadow mode must not call the LLM');
  const [memoRows] = await db
    .query("SELECT count() AS n FROM memos WHERE kind = 'reasoning' GROUP ALL")
    .collect();
  assert.equal(memoRows?.[0]?.n ?? 0, 0);
  const [tel] = await db
    .query('SELECT outcome, clusters, ts FROM meta_cognition_telemetry ORDER BY ts DESC LIMIT 1')
    .collect();
  assert.equal(tel?.[0]?.outcome, 'shadow_complete');
  assert.ok(tel?.[0]?.clusters >= 1);
  await close(db);
});

test('T5 — happy path: writes reasoning memo + rule_candidates', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  const { note } = await import('../../cognition/memory/store.js');
  await db.query('UPDATE runtime:`meta_cognition.config` SET value.enabled = true').collect();

  const ent = await db
    .query(surql`CREATE entities CONTENT { name: 'photo-tools', type: 'project', scope: 'global' }`)
    .collect();
  const entityId = ent[0][0].id;

  const memos = [];
  for (let i = 0; i < 5; i++) {
    const m = await note(db, e, 'knowledge', {
      content: `mem ${i}`,
      derived_by: 'agent',
      scope: 'global',
      subjects: [entityId],
    });
    memos.push(m.id);
  }
  for (let i = 0; i < 5; i++) {
    await db
      .query(
        surql`CREATE recall_log CONTENT {
        ts: time::now() - 1d,
        session_id: ${`s${i}`},
        query: ${`q${i}`},
        k: 5,
        ranked_hits: [{ record: ${memos[i]}, kind: 'memo' }],
        outcome: 'corrected',
      }`,
      )
      .collect();
  }

  const llmResponse = JSON.stringify({
    narrative:
      'Across this week, recall about photo-tools surfaced a stale memo about a different toolkit.',
    clusters: [
      {
        cluster_id: String(entityId),
        error_pattern: 'Stale memo about a different photography toolkit kept surfacing.',
        suggested_rules: [
          'When asked about photo-tools, do not cite memos older than 60 days.',
          'Disambiguate photo-tools from other photography toolkits before citing memos.',
        ],
        rule_confidence: [0.8, 0.6],
      },
    ],
  });

  const result = await runMetaRecallNarrative({ db, embedder: e, host: fakeHost(llmResponse) });
  const summary = JSON.parse(result);
  assert.equal(summary.ran, true);
  assert.equal(summary.rules, 2);
  assert.ok(summary.reasoning_memo_id);

  const [memoRows] = await db
    .query("SELECT id, meta, derived_by FROM memos WHERE kind = 'reasoning'")
    .collect();
  assert.equal(memoRows.length, 1);
  assert.equal(memoRows[0].derived_by, 'meta_cognition');
  assert.equal(memoRows[0].meta.dimension, 'recall_failures');
  assert.equal(memoRows[0].meta.from_signal, 'meta_cognition');
  assert.equal(memoRows[0].meta.period, 'weekly');
  assert.equal(memoRows[0].meta.signal_count, 5);
  assert.equal(memoRows[0].meta.recall_log_ids.length, 5);
  assert.ok(memoRows[0].meta.week_starting?.match(/^\d{4}-\d{2}-\d{2}$/));

  const [candRows] = await db
    .query(
      "SELECT kind, payload, content FROM rule_candidates WHERE payload.source = 'meta_cognition'",
    )
    .collect();
  assert.equal(candRows.length, 2);
  for (const c of candRows) {
    assert.equal(c.kind, 'behavior');
    assert.equal(c.payload.source, 'meta_cognition');
    assert.equal(String(c.payload.reasoning_memo_id), String(memoRows[0].id));
  }

  // about-edge from the reasoning memo to the entity.
  const [aboutEdges] = await db
    .query(surql`SELECT out FROM edges WHERE kind = 'about' AND in = ${memoRows[0].id}`)
    .collect();
  const outIds = aboutEdges.map((r) => String(r.out));
  assert.ok(outIds.includes(String(entityId)));

  const [tel] = await db
    .query(
      'SELECT outcome, clusters, rules_proposed, ts FROM meta_cognition_telemetry ORDER BY ts DESC LIMIT 1',
    )
    .collect();
  assert.equal(tel?.[0]?.outcome, 'complete');
  assert.equal(tel?.[0]?.clusters, 1);
  assert.equal(tel?.[0]?.rules_proposed, 2);
  await close(db);
});

test('T6 — max_rules_per_run cap drops over-limit suggestions', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  const { note } = await import('../../cognition/memory/store.js');
  await db
    .query(
      'UPDATE runtime:`meta_cognition.config` SET value.enabled = true, value.max_rules_per_run = 2',
    )
    .collect();

  const ent = await db
    .query(surql`CREATE entities CONTENT { name: 'x', type: 'project', scope: 'global' }`)
    .collect();
  const entId = ent[0][0].id;
  const memos = [];
  for (let i = 0; i < 5; i++) {
    const m = await note(db, e, 'knowledge', {
      content: `m${i}`,
      derived_by: 'agent',
      scope: 'global',
      subjects: [entId],
    });
    memos.push(m.id);
  }
  for (let i = 0; i < 5; i++) {
    await db
      .query(
        surql`CREATE recall_log CONTENT {
        ts: time::now() - 1d,
        session_id: ${`s${i}`}, query: 'q', k: 5,
        ranked_hits: [{ record: ${memos[i]}, kind: 'memo' }], outcome: 'corrected',
      }`,
      )
      .collect();
  }

  const llmResponse = JSON.stringify({
    narrative: 'x',
    clusters: [
      {
        cluster_id: String(entId),
        error_pattern: 'p',
        suggested_rules: ['r1', 'r2', 'r3', 'r4', 'r5'],
        rule_confidence: [0.9, 0.8, 0.7, 0.6, 0.5],
      },
    ],
  });

  await runMetaRecallNarrative({ db, embedder: e, host: fakeHost(llmResponse) });
  const [candRows] = await db
    .query("SELECT content FROM rule_candidates WHERE payload.source = 'meta_cognition'")
    .collect();
  assert.equal(candRows.length, 2);
  const contents = candRows.map((r) => r.content).sort();
  assert.deepEqual(contents, ['r1', 'r2']);
  const [tel] = await db
    .query(
      'SELECT rules_dropped_over_cap, ts FROM meta_cognition_telemetry ORDER BY ts DESC LIMIT 1',
    )
    .collect();
  assert.equal(tel?.[0]?.rules_dropped_over_cap, 3);
  await close(db);
});

test('T7 — llm_parse_error: no memo, no candidates, telemetry only', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  const { note } = await import('../../cognition/memory/store.js');
  await db.query('UPDATE runtime:`meta_cognition.config` SET value.enabled = true').collect();
  const ent = await db
    .query(surql`CREATE entities CONTENT { name: 'x', type: 'project', scope: 'global' }`)
    .collect();
  const entId = ent[0][0].id;
  for (let i = 0; i < 5; i++) {
    const m = await note(db, e, 'knowledge', {
      content: `m${i}`,
      derived_by: 'agent',
      scope: 'global',
      subjects: [entId],
    });
    await db
      .query(
        surql`CREATE recall_log CONTENT {
        ts: time::now() - 1d,
        session_id: ${`s${i}`}, query: 'q', k: 5,
        ranked_hits: [{ record: ${m.id}, kind: 'memo' }], outcome: 'corrected',
      }`,
      )
      .collect();
  }

  const result = await runMetaRecallNarrative({
    db,
    embedder: e,
    host: fakeHost('not valid json {'),
  });
  const summary = JSON.parse(result);
  assert.equal(summary.ran, false);
  assert.equal(summary.reason, 'llm_parse_error');
  const [memoRows] = await db
    .query("SELECT count() AS n FROM memos WHERE kind = 'reasoning' GROUP ALL")
    .collect();
  assert.equal(memoRows?.[0]?.n ?? 0, 0);
  const [candRows] = await db
    .query(
      "SELECT count() AS n FROM rule_candidates WHERE payload.source = 'meta_cognition' GROUP ALL",
    )
    .collect();
  assert.equal(candRows?.[0]?.n ?? 0, 0);
  const [tel] = await db
    .query('SELECT outcome, ts FROM meta_cognition_telemetry ORDER BY ts DESC LIMIT 1')
    .collect();
  assert.equal(tel?.[0]?.outcome, 'llm_parse_error');
  await close(db);
});

test('T8 — idempotence: repeat invocations write a new memo each time', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  const { note } = await import('../../cognition/memory/store.js');
  await db.query('UPDATE runtime:`meta_cognition.config` SET value.enabled = true').collect();
  const ent = await db
    .query(surql`CREATE entities CONTENT { name: 'x', type: 'project', scope: 'global' }`)
    .collect();
  const entId = ent[0][0].id;
  for (let i = 0; i < 5; i++) {
    const m = await note(db, e, 'knowledge', {
      content: `m${i}`,
      derived_by: 'agent',
      scope: 'global',
      subjects: [entId],
    });
    await db
      .query(
        surql`CREATE recall_log CONTENT {
        ts: time::now() - 1d,
        session_id: ${`s${i}`}, query: 'q', k: 5,
        ranked_hits: [{ record: ${m.id}, kind: 'memo' }], outcome: 'corrected',
      }`,
      )
      .collect();
  }

  const resp = JSON.stringify({
    narrative: 'n',
    clusters: [
      {
        cluster_id: String(entId),
        error_pattern: 'p',
        suggested_rules: ['r'],
        rule_confidence: [0.7],
      },
    ],
  });

  await runMetaRecallNarrative({ db, embedder: e, host: fakeHost(resp) });
  await runMetaRecallNarrative({ db, embedder: e, host: fakeHost(resp) });
  const [memoRows] = await db
    .query("SELECT count() AS n FROM memos WHERE kind = 'reasoning' GROUP ALL")
    .collect();
  assert.equal(memoRows?.[0]?.n, 2, 'two distinct weekly snapshots');
  const [candRows] = await db
    .query(
      "SELECT count() AS n FROM rule_candidates WHERE payload.source = 'meta_cognition' GROUP ALL",
    )
    .collect();
  assert.equal(candRows?.[0]?.n, 2);
  await close(db);
});

test('T9 — B1 absent: secondary query yields zero unused rows; corrected-only run completes', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  const { note } = await import('../../cognition/memory/store.js');
  await db.query('UPDATE runtime:`meta_cognition.config` SET value.enabled = true').collect();
  const ent = await db
    .query(surql`CREATE entities CONTENT { name: 'x', type: 'project', scope: 'global' }`)
    .collect();
  const entId = ent[0][0].id;

  // 5 corrected rows; ranked_hits[*].used field intentionally absent — pre-B1 shape.
  for (let i = 0; i < 5; i++) {
    const m = await note(db, e, 'knowledge', {
      content: `m${i}`,
      derived_by: 'agent',
      scope: 'global',
      subjects: [entId],
    });
    await db
      .query(
        surql`CREATE recall_log CONTENT {
        ts: time::now() - 1d,
        session_id: ${`s${i}`}, query: 'q', k: 5,
        ranked_hits: [{ record: ${m.id}, kind: 'memo' }],
        outcome: 'corrected',
      }`,
      )
      .collect();
  }

  const resp = JSON.stringify({
    narrative: 'n',
    clusters: [
      {
        cluster_id: String(entId),
        error_pattern: 'p',
        suggested_rules: ['r'],
        rule_confidence: [0.7],
      },
    ],
  });
  const result = await runMetaRecallNarrative({ db, embedder: e, host: fakeHost(resp) });
  const summary = JSON.parse(result);
  assert.equal(summary.ran, true);
  const [tel] = await db
    .query(
      'SELECT unused_count, rows_after_privacy, ts FROM meta_cognition_telemetry ORDER BY ts DESC LIMIT 1',
    )
    .collect();
  assert.equal(tel?.[0]?.unused_count, 0);
  assert.equal(tel?.[0]?.rows_after_privacy, 5);
  await close(db);
});
