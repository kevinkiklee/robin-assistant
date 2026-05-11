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

  // The rest of the pipeline is wired in subsequent tasks.
  return JSON.stringify({ ran: false, reason: 'not_yet_implemented' });
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

