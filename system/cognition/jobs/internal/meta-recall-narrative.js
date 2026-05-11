// meta-recall-narrative.js — weekly internal job for D2 meta-cognition.
// Spec §1.4, §3. Pulls `recall_log` failures from the trailing 7 days,
// clusters them by shared `about` endpoints, calls one tier:'fast' LLM,
// writes a `kind='reasoning'` memo + 0-3 rule_candidates.
//
// Manifest: cognition/jobs/builtin/meta-recall-narrative.md
// Schedule: 0 5 * * 0 (Sunday 05:00 local time).

import { BoundQuery, RecordId, surql } from 'surrealdb';
import { createCandidate } from '../../dream/candidates.js';
import { note } from '../../memory/store.js';
import { clusterByAboutEndpoints } from '../../meta_cognition/cluster.js';
import { validateMetaCognitionOutput } from '../../meta_cognition/output.js';
import { buildUserPrompt, META_COGNITION_SYSTEM } from '../../meta_cognition/prompt.js';

const SECONDARY_OUTCOME = 'unused';

const DEFAULT_CFG = {
  enabled: false,
  min_corrections_threshold: 5,
  lookback_days: 7,
  max_corrected_rows: 200,
  max_unused_rows: 200,
  top_k_clusters: 3,
  min_cluster_size: 2,
  unused_signal_weight: 0.33,
  tier: 'fast',
  max_tokens_in: 3000,
  max_tokens_out: 1200,
  max_rules_per_run: 3,
  weekly_token_budget: 6000,
  private_scope_action: 'drop',
  reasoning_memo_scope: 'global',
};

export default async function runMetaRecallNarrative({ db, embedder, host }) {
  const startedAt = Date.now();
  const config = await readConfig(db);

  if (config.enabled === false) {
    await emitTelemetry(db, {
      outcome: 'skipped_disabled',
      duration_ms: Date.now() - startedAt,
    });
    return JSON.stringify({ ran: false, reason: 'disabled' });
  }

  // §1.2 gate.
  const correctedCount = await countCorrectedInWindow(db, config.lookback_days);
  if (correctedCount < config.min_corrections_threshold) {
    await emitTelemetry(db, {
      outcome: 'skipped_below_threshold',
      corrected_count: correctedCount,
      duration_ms: Date.now() - startedAt,
    });
    return JSON.stringify({
      ran: false,
      reason: 'below_threshold',
      corrected_count: correctedCount,
    });
  }

  // §3.1 input gathering.
  const correctedRows = await selectCorrectedRows(db, config);
  const unusedRows = await selectUnusedRows(db, config);
  const inputRows = mergeAndDedupRows(correctedRows, unusedRows);

  // Privacy filter wired in Task 5.3 — for now, pass-through.
  const cleanRows = inputRows;
  const droppedPrivate = 0;

  if (cleanRows.length === 0) {
    await emitTelemetry(db, {
      outcome: 'no_clusters',
      corrected_count: correctedCount,
      unused_count: unusedRows.length,
      rows_after_privacy: 0,
      dropped_private: droppedPrivate,
      duration_ms: Date.now() - startedAt,
    });
    return JSON.stringify({ ran: false, reason: 'no_clusters' });
  }

  // Hydration + clustering + LLM + writes wired in Tasks 5.4–5.5.
  await emitTelemetry(db, {
    outcome: 'no_clusters',
    corrected_count: correctedCount,
    unused_count: unusedRows.length,
    rows_after_privacy: cleanRows.length,
    dropped_private: droppedPrivate,
    duration_ms: Date.now() - startedAt,
  });
  return JSON.stringify({ ran: false, reason: 'no_clusters' });
}

async function selectCorrectedRows(db, config) {
  const days =
    Number.isInteger(config.lookback_days) && config.lookback_days > 0 ? config.lookback_days : 7;
  const [rows] = await db
    .query(
      new BoundQuery(
        `SELECT id, ts, session_id, query, ranked_hits, attribution, meta
         FROM recall_log
         WHERE outcome = 'corrected'
           AND ts > time::now() - ${days}d
         ORDER BY ts DESC
         LIMIT $cap`,
        { cap: config.max_corrected_rows },
      ),
    )
    .collect();
  return (rows ?? []).map((r) => ({ ...r, outcome: 'corrected' }));
}

async function selectUnusedRows(db, config) {
  // `ranked_hits[*].used CONTAINS false` only matches when B1 has populated
  // the `used` field. Pre-B1 the projection yields an empty list and the
  // CONTAINS is false — secondary query is empty by construction.
  const days =
    Number.isInteger(config.lookback_days) && config.lookback_days > 0 ? config.lookback_days : 7;
  try {
    const [rows] = await db
      .query(
        new BoundQuery(
          `SELECT id, ts, session_id, query, ranked_hits, attribution, meta
           FROM recall_log
           WHERE ts > time::now() - ${days}d
             AND attribution.mode != 'corrected'
             AND attribution.mode != 'off'
             AND ranked_hits[*].used CONTAINS false
           ORDER BY ts DESC
           LIMIT $cap`,
          { cap: config.max_unused_rows },
        ),
      )
      .collect();
    return (rows ?? []).map((r) => ({ ...r, outcome: SECONDARY_OUTCOME }));
  } catch {
    // Older engine without array projection — return empty. D2 still runs
    // on corrected-only signal.
    return [];
  }
}

function mergeAndDedupRows(corrected, unused) {
  // Corrected wins on dedup so weight stays at 1.0.
  const byId = new Map();
  for (const r of corrected) byId.set(String(r.id), r);
  for (const r of unused) if (!byId.has(String(r.id))) byId.set(String(r.id), r);
  return [...byId.values()];
}

async function readConfig(db) {
  try {
    const [rows] = await db
      .query('SELECT VALUE value FROM runtime:`meta_cognition.config`')
      .collect();
    const v = rows?.[0] ?? {};
    return { ...DEFAULT_CFG, ...v };
  } catch {
    return { ...DEFAULT_CFG };
  }
}

async function countCorrectedInWindow(db, lookbackDays) {
  // Inline duration literal — `${n}d` resolves at SurrealQL parse time. We can't
  // bind a duration via $param because the engine doesn't coerce ints to
  // durations in arithmetic context. Validate `lookbackDays` first.
  const days = Number.isInteger(lookbackDays) && lookbackDays > 0 ? lookbackDays : 7;
  const [rows] = await db
    .query(
      `SELECT count() AS n FROM recall_log
        WHERE outcome = 'corrected'
          AND ts > time::now() - ${days}d
        GROUP ALL`,
    )
    .collect();
  return rows?.[0]?.n ?? 0;
}

async function emitTelemetry(db, fields) {
  try {
    await db.query(surql`CREATE meta_cognition_telemetry CONTENT ${fields}`).collect();
  } catch {
    // Best-effort — telemetry must not break the job.
  }
}
