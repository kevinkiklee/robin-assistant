import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { runEval } from '../../cognition/intuition/eval.js';
import * as store from '../../cognition/memory/store.js';
import { writeConfig } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';
import { createStubEmbedder } from '../../data/embed/embedder.js';
import { recordEvent } from '../../io/capture/record-event.js';

async function fresh() {
  const home = mkdtempSync(join(tmpdir(), 'robin-replay-test-'));
  process.env.ROBIN_HOME = home;
  await writeConfig({ embedder_profile: 'mxbai-1024' });
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../data/db/migrations'));
  await db
    .query(surql`UPSERT runtime:embedder SET value = { active_profile: 'mxbai-1024' }`)
    .collect();
  return db;
}

test('runEval replay reproduces precision@k against seeded recall_log rows', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });

  const ev1 = await recordEvent(db, e, {
    source: 'cli',
    content: 'sourdough hydration 62%',
  });

  // Seed 8 memos so we can produce 8 recall_log rows with mixed outcomes.
  const memos = [];
  for (let i = 0; i < 8; i++) {
    memos.push(
      await store.note(db, e, 'knowledge', {
        content: `memo content for row ${i}`,
        derived_by: 'manual',
      }),
    );
  }

  const rows = [
    {
      outcome: 'reinforced',
      hits: [
        { kind: 'memo', rec: memos[0].id },
        { kind: 'event', rec: ev1.id },
      ],
    },
    { outcome: 'reinforced', hits: [{ kind: 'memo', rec: memos[1].id }] },
    {
      outcome: 'reinforced',
      hits: [
        { kind: 'memo', rec: memos[2].id },
        { kind: 'memo', rec: memos[3].id },
      ],
    },
    { outcome: 'corrected', hits: [{ kind: 'memo', rec: memos[4].id }] },
    {
      outcome: 'corrected',
      hits: [
        { kind: 'memo', rec: memos[5].id },
        { kind: 'memo', rec: memos[6].id },
      ],
    },
    { outcome: 'corrected', hits: [{ kind: 'memo', rec: memos[7].id }] },
    { outcome: 'evaluated_no_signal', hits: [] },
    { outcome: 'evaluated_no_signal', hits: [] },
  ];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    await db
      .query(
        surql`CREATE recall_log CONTENT ${{
          ts: new Date(Date.now() - (60 - i * 5) * 60_000),
          session_id: `s${i}`,
          query: `query ${i}`,
          k: 6,
          ranked_hits: r.hits.map((h, j) => ({ record: h.rec, kind: h.kind, rank: j })),
          outcome: r.outcome,
          meta: {
            latency_ms: 50 + i,
            from: 'intuition',
            focus_block_present: false,
            focus_block_tokens: 0,
          },
        }}`,
      )
      .collect();
  }

  const result = await runEval({
    db,
    embedder: e,
    windowStart: new Date(Date.now() - 86_400_000),
    windowEnd: new Date(),
    profile: 'mxbai-1024',
    sourceFilter: 'all',
    replay: true,
    limit: 100,
    ks: [1, 3, 6, 10],
  });

  assert.equal(result.rows_scored, 8);
  assert.equal(result.rows_pending, 0);
  // Hand derivation @3 (evaluated rows only; pending excluded):
  //   reinforced[0]: 1 sp in top-3 → 1/3
  //   reinforced[1]: 1/3
  //   reinforced[2]: 2/3
  //   corrected[0..2]: 0
  //   evaluated_no_signal × 2: 0
  // avg = (1/3 + 1/3 + 2/3 + 0 + 0 + 0 + 0 + 0) / 8 = (4/3)/8 ≈ 0.1667
  assert.ok(
    Math.abs(result.metrics.precision_at_3 - 0.1667) < 0.001,
    `precision_at_3 = ${result.metrics.precision_at_3}`,
  );
  // recall@3: each reinforced row has full coverage of its sp set in top-3.
  //   3 of 8 rows contribute 1.0; the rest contribute 0 → avg 3/8 = 0.375
  assert.ok(
    Math.abs(result.metrics.recall_at_3 - 0.375) < 0.001,
    `recall_at_3 = ${result.metrics.recall_at_3}`,
  );
  // no_signal_rate: 2 / 8 evaluated = 0.25
  assert.ok(
    Math.abs(result.metrics.no_signal_rate - 0.25) < 0.001,
    `no_signal_rate = ${result.metrics.no_signal_rate}`,
  );
  // mean_rank_of_negatives@10: corrected[0] → rank 1; corrected[1] → mean(1,2)=1.5; corrected[2] → 1; mean=(1+1.5+1)/3≈1.1667
  assert.ok(
    result.metrics.mean_rank_of_negatives_at_10 != null &&
      Math.abs(result.metrics.mean_rank_of_negatives_at_10 - 1.1667) < 0.001,
    `mean_rank_of_negatives_at_10 = ${result.metrics.mean_rank_of_negatives_at_10}`,
  );
  assert.ok(typeof result.replay_kendall_mean === 'number' || result.replay_kendall_mean === null);

  await close(db);
});
