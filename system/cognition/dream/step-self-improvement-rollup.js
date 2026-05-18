// step-self-improvement-rollup.js — Dream step: write v2 metrics rollup.
// L3 step; depends on all other v2 steps.
// Writes runtime:`self-improvement-v2`.metrics with the spec §6 success-criteria
// signals: pipeline yield, behavior change, cost/performance.
//
// FAIL-SOFT: an error here MUST NOT abort the Dream run.

import { surql } from 'surrealdb';
import { isSelfImprovementV2Enabled } from '../../runtime/config/self-improvement-v2.js';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const MONTH_MS = 30 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

// Seed task_types per spec §6 success criterion ("playbooks active for
// daily-briefing + outbound:discord_send:send_dm + 3 of 5 seed turn:*").
const SEED_TURN_INTENTS = ['recommend', 'analyze', 'plan', 'execute_change', 'default'];

/**
 * Compute and persist v2 metrics. Returns the metrics object on success or
 * an error-shape on failure (never throws).
 */
export async function dreamStepSelfImprovementRollup(db) {
  if (!(await isSelfImprovementV2Enabled(db))) {
    return { skipped: true, reason: 'v2_not_enabled', step: 'selfImprovementRollup' };
  }

  try {
    const metrics = await computeMetrics(db);
    await writeMetrics(db, metrics);
    return {
      skipped: false,
      step: 'selfImprovementRollup',
      metrics_keys: Object.keys(metrics),
    };
  } catch (e) {
    console.warn(`[dream/self-improvement-rollup] failed: ${e?.message ?? e}`);
    return {
      skipped: false,
      step: 'selfImprovementRollup',
      error: String(e?.message ?? e),
    };
  }
}

/**
 * Compute the full metrics blob per spec §6.
 *
 * @param {import('surrealdb').Surreal} db
 * @returns {Promise<object>}
 */
export async function computeMetrics(db) {
  const now = new Date();
  const weekAgo = new Date(now.getTime() - WEEK_MS);
  const monthAgo = new Date(now.getTime() - MONTH_MS);
  const dayAgo = new Date(now.getTime() - DAY_MS);

  // ── Pipeline yield ─────────────────────────────────────────────────────
  const ruleCandidatesPerWeek = await scalarCount(
    db,
    surql`SELECT count() AS c FROM rule_candidates WHERE created_at >= ${weekAgo}`,
  );

  const activePlaybooks = await mapAggregate(
    db,
    surql`SELECT meta.task_type AS task_type, count() AS c
          FROM memos
          WHERE kind = 'playbook' AND meta.active = true
          GROUP BY meta.task_type`,
    'task_type',
    'c',
  );

  // Spec §6 calls out specific task_types that should have ≥1 active playbook.
  const requiredPlaybookTaskTypes = [
    'job:daily-briefing',
    'outbound:discord_send:send_dm',
    ...SEED_TURN_INTENTS.map((i) => `turn:${i}`),
  ];
  const playbookCoverage = {
    required: requiredPlaybookTaskTypes,
    present: requiredPlaybookTaskTypes.filter((t) => (activePlaybooks[t] ?? 0) >= 1),
  };

  const confidenceBandRowsByKind = await mapAggregate(
    db,
    surql`SELECT meta.statement_kind AS kind, count() AS c
          FROM memos
          WHERE kind = 'confidence_band'
          GROUP BY meta.statement_kind`,
    'kind',
    'c',
  );
  const confidenceBandBucketsPopulated = Object.values(confidenceBandRowsByKind).reduce(
    (a, b) => a + (b ?? 0),
    0,
  );

  // ── Behavior change ────────────────────────────────────────────────────
  // Repeat-correction rate per task_type over the trailing 30 days.
  // A "repeat" is a task_type where ≥3 task_outcomes carry signals.explicit_correction.
  const repeatCorrections = await db
    .query(
      surql`SELECT meta.task_type AS task_type, count() AS c
            FROM memos
            WHERE kind = 'task_outcome'
              AND derived_at >= ${monthAgo}
              AND meta.signals.explicit_correction != NONE
            GROUP BY meta.task_type`,
    )
    .collect()
    .then(([rows]) => rows ?? [])
    .catch(() => []);
  const repeatCorrectionByTaskType = {};
  for (const r of repeatCorrections) {
    if (r.task_type) repeatCorrectionByTaskType[r.task_type] = r.c;
  }
  const repeatCorrectionTaskTypes = Object.values(repeatCorrectionByTaskType).filter(
    (c) => c >= 3,
  ).length;

  // outbound_blocked outcomes per day for daily-briefing.
  const outboundBlockedDailyBrief = await scalarCount(
    db,
    surql`SELECT count() AS c FROM memos
          WHERE kind = 'task_outcome'
            AND meta.task_type = 'job:daily-briefing'
            AND meta.signals.outcome_inference.kind = 'outbound_blocked'
            AND derived_at >= ${dayAgo}`,
  );

  // ── Cost / performance ────────────────────────────────────────────────
  const dailyLlmCostUsd = await scalarSum(
    db,
    surql`SELECT math::sum(metrics.cost_usd) AS s FROM telemetry_hourly
          WHERE event_kind = 'llm_call' AND ts >= ${dayAgo}`,
  );

  const introspectionRestarts24h = await scalarCount(
    db,
    surql`SELECT count() AS c FROM events
          WHERE source = 'introspection_sample'
            AND meta.event_kind = 'restart'
            AND ts >= ${dayAgo}`,
  );

  // ── Negative metric: auto-applied playbook revisions corrected within 24h ─
  // Count playbooks that became `active=false, retraction_reason=correction`
  // within 24h of their creation. Compare against playbooks created in the
  // same window for the rate.
  const playbooksCreated24h = await scalarCount(
    db,
    surql`SELECT count() AS c FROM memos
          WHERE kind = 'playbook' AND derived_at >= ${dayAgo}`,
  );
  const playbooksCorrected24h = await scalarCount(
    db,
    surql`SELECT count() AS c FROM memos
          WHERE kind = 'playbook'
            AND derived_at >= ${dayAgo}
            AND meta.retraction_reason != NONE`,
  );
  const playbookEarlyCorrectionRate =
    playbooksCreated24h > 0 ? playbooksCorrected24h / playbooksCreated24h : 0;

  return {
    last_computed_at: now.toISOString(),
    // Pipeline yield (spec §6).
    pipeline_yield: {
      rule_candidates_per_week: ruleCandidatesPerWeek,
      active_playbooks_by_task_type: activePlaybooks,
      playbook_coverage: playbookCoverage,
      confidence_band_buckets_populated: confidenceBandBucketsPopulated,
      confidence_band_rows_by_kind: confidenceBandRowsByKind,
    },
    // Behavior change (spec §6).
    behavior_change: {
      repeat_correction_task_types: repeatCorrectionTaskTypes,
      repeat_correction_by_task_type: repeatCorrectionByTaskType,
      outbound_blocked_daily_brief_24h: outboundBlockedDailyBrief,
    },
    // Cost / performance (spec §6).
    cost_performance: {
      daily_llm_cost_usd: dailyLlmCostUsd,
      introspection_restarts_24h: introspectionRestarts24h,
    },
    // Negative metric (spec §6).
    quality_signals: {
      playbook_early_correction_rate: playbookEarlyCorrectionRate,
      playbooks_created_24h: playbooksCreated24h,
      playbooks_corrected_24h: playbooksCorrected24h,
    },
  };
}

/**
 * Upsert the metrics blob into runtime:`self-improvement-v2`.metrics.
 * Preserves other fields on the row (enabled, phase2_started_at, etc.).
 */
async function writeMetrics(db, metrics) {
  await db
    .query(surql`UPSERT runtime:\`self-improvement-v2\` SET value.metrics = ${metrics}`)
    .collect();
}

// ── Tiny query helpers ──────────────────────────────────────────────────

async function scalarCount(db, sql) {
  try {
    const [rows] = await db.query(sql).collect();
    const r = Array.isArray(rows) ? rows[0] : rows;
    return Number(r?.c ?? 0);
  } catch {
    return 0;
  }
}

async function scalarSum(db, sql) {
  try {
    const [rows] = await db.query(sql).collect();
    const r = Array.isArray(rows) ? rows[0] : rows;
    return Number(r?.s ?? 0);
  } catch {
    return 0;
  }
}

async function mapAggregate(db, sql, keyField, valueField) {
  try {
    const [rows] = await db.query(sql).collect();
    const out = {};
    for (const r of rows ?? []) {
      const k = r?.[keyField];
      const v = Number(r?.[valueField] ?? 0);
      if (k != null) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}
