// meta-calibration-narrative.js — weekly Sunday 05:30 local writer.
// Spec §6. Reads resolved predictions for past 7d / prior 7d / prior 21d
// of meta_cognition memos; computes per-domain brier + drift + trend;
// writes one kind='reasoning', meta.dimension='calibration' memo per
// domain (idempotent on (domain, week_starting)); conditionally emits
// a rule_candidates row with kind='behavior',
// payload.source='meta_cognition_calibration'.

import { BoundQuery } from 'surrealdb';
import { createStubEmbedder } from '../../../data/embed/embedder.js';
import { readBeliefConfig } from '../../belief/config.js';
import { createCandidate } from '../../dream/candidates.js';
import * as store from '../../memory/store.js';

const TELEMETRY_STEP = 'meta-cal-narrative';

/** Pure: stats per domain. */
export function computeDomainStats(preds) {
  const n = preds.length;
  if (n === 0) return null;
  let brier = 0;
  let correct = 0;
  let meanC = 0;
  for (const p of preds) {
    const target = p.correct ? 1 : 0;
    brier += (p.predicted_confidence - target) ** 2;
    if (p.correct) correct++;
    meanC += p.predicted_confidence;
  }
  brier /= n;
  const accuracy = correct / n;
  const mean_confidence = meanC / n;
  return { brier, accuracy, mean_confidence, drift: mean_confidence - accuracy, samples: n };
}

export function computeTrend(brier, prev_brier) {
  if (prev_brier == null) return 'new';
  const d = brier - prev_brier;
  if (d > 0.05) return 'worsening';
  if (d < -0.05) return 'improving';
  return 'flat';
}

/**
 * priorWeeks: ordered most-recent first; only entries with `drift` are required.
 * Returns true iff this week + the last `min_weeks - 1` prior weeks all
 * cross the threshold in the same direction.
 */
export function shouldEmitRule(current, priorWeeks, cfg) {
  const thr = cfg.meta_narrative_rule_threshold ?? 0.15;
  const minW = cfg.meta_narrative_rule_min_weeks ?? 2;
  if (Math.abs(current.drift) < thr) return false;
  const sign = Math.sign(current.drift);
  const required = minW - 1;
  for (let i = 0; i < required; i++) {
    const w = priorWeeks[i];
    if (!w) return false;
    if (Math.abs(w.drift) < thr) return false;
    if (Math.sign(w.drift) !== sign) return false;
  }
  return true;
}

/** Convert any date to the ISO date string of the Sunday at the start of its week (LOCAL). */
export function weekStartingISO(d = new Date()) {
  const local = new Date(d);
  local.setHours(0, 0, 0, 0);
  const dayOfWeek = local.getDay(); // 0 = Sunday
  local.setDate(local.getDate() - dayOfWeek);
  const y = local.getFullYear();
  const m = String(local.getMonth() + 1).padStart(2, '0');
  const day = String(local.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

async function recordTelemetry(db, row) {
  try {
    await db.query(new BoundQuery('CREATE cadence_telemetry CONTENT $row', { row })).collect();
  } catch {
    /* advisory */
  }
}

async function dedupExists(db, domain, week) {
  try {
    const [rows] = await db
      .query(
        new BoundQuery(
          `SELECT 1 FROM memos
           WHERE kind = 'reasoning'
             AND meta.dimension = 'calibration'
             AND meta.domain = $domain
             AND meta.week_starting = $week
           LIMIT 1`,
          { domain, week },
        ),
      )
      .collect();
    return Array.isArray(rows) && rows.length > 0;
  } catch {
    return false;
  }
}

/**
 * Entrypoint: invoked by the heartbeat scheduler when the manifest cron fires.
 * `host` is unused (no LLM calls).
 *
 * @returns {Promise<{ wrote: string[], skipped: string[], rules: string[] }>}
 */
export async function runMetaCalibrationNarrative({ db, embedder, now = new Date() }) {
  const startedAt = Date.now();
  const cfg = await readBeliefConfig(db);
  if (!cfg.meta_narrative_enabled) {
    await recordTelemetry(db, {
      step: TELEMETRY_STEP,
      tokens_in: 0,
      tokens_out: 0,
      duration_ms: Date.now() - startedAt,
      success: true,
      meta: { reason: 'disabled' },
    });
    return { wrote: [], skipped: [], rules: [] };
  }

  const week = weekStartingISO(now);
  const e = embedder ?? createStubEmbedder({ dimension: 1024 });

  // Past 7d resolved predictions, grouped by statement_kind.
  let predRows = [];
  try {
    const [r] = await db
      .query(`
      SELECT meta.statement_kind AS domain,
             meta.correct        AS correct,
             confidence          AS predicted_confidence,
             meta.resolved_at    AS resolved_at
      FROM memos
      WHERE kind = 'prediction'
        AND meta.resolved_at IS NOT NONE
        AND meta.resolved_at >= time::now() - 7d
    `)
      .collect();
    predRows = r ?? [];
  } catch {
    predRows = [];
  }

  // Prior 7d.
  let priorPredRows = [];
  try {
    const [r] = await db
      .query(`
      SELECT meta.statement_kind AS domain,
             meta.correct        AS correct,
             confidence          AS predicted_confidence
      FROM memos
      WHERE kind = 'prediction'
        AND meta.resolved_at >= time::now() - 14d
        AND meta.resolved_at <  time::now() - 7d
    `)
      .collect();
    priorPredRows = r ?? [];
  } catch {
    priorPredRows = [];
  }

  // Most-recent prior meta-narrative memos per domain (last 21d).
  let priorMetaRows = [];
  try {
    const [r] = await db
      .query(`
      SELECT meta.domain AS domain, meta.brier AS brier, meta.drift AS drift,
             derived_at AS derived_at
      FROM memos
      WHERE kind = 'reasoning'
        AND meta.dimension = 'calibration'
        AND meta.from_signal = 'meta_cognition'
        AND derived_at >= time::now() - 21d
      ORDER BY derived_at DESC
    `)
      .collect();
    priorMetaRows = r ?? [];
  } catch {
    priorMetaRows = [];
  }

  // Group by domain.
  const byDomain = new Map();
  for (const p of predRows) {
    const d = p.domain ?? 'unknown';
    if (!byDomain.has(d)) byDomain.set(d, []);
    byDomain.get(d).push(p);
  }
  const priorByDomain = new Map();
  for (const p of priorPredRows) {
    const d = p.domain ?? 'unknown';
    if (!priorByDomain.has(d)) priorByDomain.set(d, []);
    priorByDomain.get(d).push(p);
  }
  const priorMetaByDomain = new Map();
  for (const r of priorMetaRows) {
    const d = r.domain;
    if (!d) continue;
    if (!priorMetaByDomain.has(d)) priorMetaByDomain.set(d, []);
    priorMetaByDomain.get(d).push({ drift: r.drift, brier: r.brier });
  }

  const wrote = [];
  const skipped = [];
  const rules = [];
  const minSamples = cfg.meta_narrative_min_samples ?? 5;
  const driftHighlight = cfg.meta_narrative_drift_threshold ?? 0.15;

  for (const [domain, preds] of byDomain.entries()) {
    if (preds.length < minSamples) {
      skipped.push(domain);
      continue;
    }
    if (await dedupExists(db, domain, week)) {
      skipped.push(domain);
      continue;
    }
    const stats = computeDomainStats(preds);
    const priorPreds = priorByDomain.get(domain) ?? [];
    const priorStats = priorPreds.length >= minSamples ? computeDomainStats(priorPreds) : null;
    const trend = computeTrend(stats.brier, priorStats?.brier ?? null);

    const baseContent =
      `Calibration drift for ${domain} this week: ` +
      `brier=${stats.brier.toFixed(3)}, drift=${stats.drift.toFixed(2)} ` +
      `(mean confidence ${stats.mean_confidence.toFixed(2)} vs accuracy ${stats.accuracy.toFixed(2)}), ` +
      `samples=${stats.samples}, trend=${trend} vs prior week ` +
      `(${priorStats ? priorStats.brier.toFixed(3) : 'n/a'}).`;

    const content =
      Math.abs(stats.drift) > driftHighlight
        ? `Notable calibration drift: ${domain} is trending ${stats.drift > 0 ? 'over-confident' : 'under-confident'}. ${baseContent}`
        : baseContent;

    const { id } = await store.note(db, e, 'reasoning', {
      content,
      derived_by: 'auto',
      scope: 'global',
      confidence: 0.8,
      meta: {
        dimension: 'calibration',
        from_signal: 'meta_cognition',
        domain,
        brier: stats.brier,
        drift: stats.drift,
        accuracy: stats.accuracy,
        mean_confidence: stats.mean_confidence,
        samples: stats.samples,
        trend,
        week_starting: week,
      },
    });
    wrote.push(String(id));

    // Rule candidate emission.
    const priorMeta = priorMetaByDomain.get(domain) ?? [];
    if (shouldEmitRule({ drift: stats.drift }, priorMeta, cfg)) {
      const weeks_in_drift =
        1 +
        priorMeta.filter(
          (w) =>
            Math.abs(w.drift) >= (cfg.meta_narrative_rule_threshold ?? 0.15) &&
            Math.sign(w.drift) === Math.sign(stats.drift),
        ).length;
      const ruleContent =
        stats.drift > 0
          ? `Soften assertions about ${domain}: over-confident by drift=${stats.drift.toFixed(2)} for ${weeks_in_drift}+ consecutive weeks.`
          : `Trust assertions about ${domain} more: under-confident by drift=${stats.drift.toFixed(2)} for ${weeks_in_drift}+ consecutive weeks.`;
      try {
        const cand = await createCandidate(db, {
          content: ruleContent,
          kind: 'behavior', // enum-safe
          signal_events: [],
          confidence: Math.min(0.9, 0.5 + Math.abs(stats.drift)),
          // Discriminator lives on `payload` (rule_candidates is SCHEMAFULL —
          // undeclared top-level `meta` is silently dropped). The dimension +
          // domain context travels INSIDE payload.
          payload: {
            source: 'meta_cognition_calibration',
            dimension: 'calibration',
            domain,
            drift: stats.drift,
            weeks_in_drift,
          },
        });
        rules.push(String(cand?.id ?? ''));
      } catch (err) {
        await recordTelemetry(db, {
          step: TELEMETRY_STEP,
          tokens_in: 0,
          tokens_out: 0,
          duration_ms: 0,
          success: false,
          error: String(err?.message ?? err),
          meta: { phase: 'rule_emit', domain },
        });
      }
    }
  }

  await recordTelemetry(db, {
    step: TELEMETRY_STEP,
    tokens_in: 0,
    tokens_out: 0,
    duration_ms: Date.now() - startedAt,
    success: true,
    meta: { wrote: wrote.length, skipped: skipped.length, rules: rules.length, week },
  });

  return { wrote, skipped, rules };
}

/** Default export — the internal-runtime entrypoint per system/cognition/jobs/runner.js. */
export default async function run(ctx) {
  return runMetaCalibrationNarrative({
    db: ctx.db,
    embedder: ctx.embedder?.wrap ?? ctx.embedder ?? null,
  });
}
