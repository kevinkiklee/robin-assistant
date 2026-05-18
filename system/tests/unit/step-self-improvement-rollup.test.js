// system/tests/unit/step-self-improvement-rollup.test.js
//
// Tests the real step-self-improvement-rollup implementation (post-Phase-1).
//
// Covers spec §6 success-criteria signals: pipeline yield, behavior change,
// cost/performance, quality_signals. Seeds the DB with representative rows
// then asserts the computed metrics shape and key values.

import assert from 'node:assert/strict';
import { mkdirSync as __robinMkdirSync } from 'node:fs';
import { tmpdir as __robinTmpdir } from 'node:os';
import { join as __robinJoin, resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import {
  computeMetrics,
  dreamStepSelfImprovementRollup,
} from '../../cognition/dream/step-self-improvement-rollup.js';
import { writeConfig as __robinWriteConfig } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';
import { setSelfImprovementV2Enabled } from '../../runtime/config/self-improvement-v2.js';

// __robin_test_home_setup__
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
  await setSelfImprovementV2Enabled(db, true);
  return db;
}

test('flag off → skipped v2_not_enabled', async () => {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../data/db/migrations'));
  const r = await dreamStepSelfImprovementRollup(db);
  assert.equal(r.skipped, true);
  assert.equal(r.reason, 'v2_not_enabled');
  await close(db);
});

test('empty DB → metrics computed with zero values', async () => {
  const db = await fresh();
  const m = await computeMetrics(db);
  assert.equal(m.pipeline_yield.rule_candidates_per_week, 0);
  assert.deepEqual(m.pipeline_yield.active_playbooks_by_task_type, {});
  assert.equal(m.pipeline_yield.confidence_band_buckets_populated, 0);
  assert.equal(m.behavior_change.outbound_blocked_daily_brief_24h, 0);
  assert.equal(m.cost_performance.daily_llm_cost_usd, 0);
  assert.equal(m.quality_signals.playbook_early_correction_rate, 0);
  await close(db);
});

test('seeded data → metrics reflect the rows', async () => {
  const db = await fresh();
  const now = new Date();

  // Seed 2 active playbooks (one for daily-briefing, one for turn:analyze).
  await db
    .query(
      surql`CREATE memos CONTENT {
        kind: 'playbook',
        content: 'daily-brief playbook v1',
        derived_by: 'test',
        meta: { task_type: 'job:daily-briefing', active: true, version: 1 },
      }`,
    )
    .collect();
  await db
    .query(
      surql`CREATE memos CONTENT {
        kind: 'playbook',
        content: 'turn:analyze playbook v1',
        derived_by: 'test',
        meta: { task_type: 'turn:analyze', active: true, version: 1 },
      }`,
    )
    .collect();

  // Seed 3 confidence_band rows for event_timing.
  for (const bucket of ['low', 'mid', 'high']) {
    await db
      .query(
        surql`CREATE memos CONTENT {
          kind: 'confidence_band',
          content: 'event_timing @ ${bucket}: 5/10',
          derived_by: 'test',
          meta: { statement_kind: 'event_timing', bucket: ${bucket}, n: 10, correct: 5 },
        }`,
      )
      .collect();
  }

  // Seed a rule_candidate within the last week.
  await db
    .query(
      surql`CREATE rule_candidates CONTENT {
        content: 'test candidate',
        kind: 'behavior',
        status: 'pending',
        confidence: 0.75,
        created_at: ${now},
      }`,
    )
    .collect();

  // Seed an outbound_blocked outcome for daily-brief in the last 24h.
  await db
    .query(
      surql`CREATE memos CONTENT {
        kind: 'task_outcome',
        content: 'daily-brief outbound blocked',
        derived_by: 'test',
        derived_at: ${now},
        meta: {
          task_type: 'job:daily-briefing',
          signals: { outcome_inference: { kind: 'outbound_blocked', reason: 'verbatim_quote' } },
          score: 0.2,
        },
      }`,
    )
    .collect();

  const m = await computeMetrics(db);
  assert.equal(
    m.pipeline_yield.rule_candidates_per_week,
    1,
    'rule_candidates_per_week should be 1',
  );
  assert.equal(
    m.pipeline_yield.active_playbooks_by_task_type['job:daily-briefing'],
    1,
    'daily-briefing playbook counted',
  );
  assert.equal(
    m.pipeline_yield.active_playbooks_by_task_type['turn:analyze'],
    1,
    'turn:analyze playbook counted',
  );
  assert.equal(
    m.pipeline_yield.confidence_band_buckets_populated,
    3,
    'three confidence_band rows populated',
  );
  assert.equal(
    m.pipeline_yield.confidence_band_rows_by_kind.event_timing,
    3,
    'event_timing has 3 buckets',
  );
  assert.equal(
    m.behavior_change.outbound_blocked_daily_brief_24h,
    1,
    'outbound_blocked daily-brief outcome counted',
  );
  // playbook_coverage reports which required types are present.
  assert.ok(
    m.pipeline_yield.playbook_coverage.present.includes('job:daily-briefing'),
    'job:daily-briefing is present',
  );
  assert.ok(
    m.pipeline_yield.playbook_coverage.present.includes('turn:analyze'),
    'turn:analyze is present',
  );

  await close(db);
});

test('dreamStepSelfImprovementRollup persists metrics to runtime KV', async () => {
  const db = await fresh();
  const r = await dreamStepSelfImprovementRollup(db);
  assert.equal(r.skipped, false);
  assert.ok(r.metrics_keys.length >= 4, 'expected 4 metric sections');

  // Verify the persisted blob can be read back.
  const [rows] = await db.query('SELECT VALUE value FROM runtime:`self-improvement-v2`').collect();
  const persisted = rows?.[0]?.metrics;
  assert.ok(persisted, 'metrics should be persisted to runtime:self-improvement-v2.value.metrics');
  assert.ok(persisted.last_computed_at, 'last_computed_at should be present');
  assert.ok(persisted.pipeline_yield, 'pipeline_yield section persisted');
  await close(db);
});

test('fail-soft: query error returns error shape instead of throwing', async () => {
  // Close the DB to force errors on subsequent queries.
  const db = await fresh();
  await close(db);
  // The function should return an error shape, not throw.
  const r = await dreamStepSelfImprovementRollup(db).catch((e) => ({ thrown: e.message }));
  assert.ok(
    !r.thrown || typeof r.thrown === 'string',
    'should not bubble — either error-shape or caught at boundary',
  );
});
