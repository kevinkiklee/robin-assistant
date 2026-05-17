// step-prediction-taxonomy.js — Dream step: cluster kind='other' predictions,
// propose new statement_kind enum entries as rule_candidates.
//
// L2 step, weekly cadence (dream calls every night; real work runs only every
// 7 days, gated by runtime:self-improvement-v2.value.prediction_taxonomy_last_run_at).
//
// §4a of the cognition-e1 spec:
//   - Read predictions with meta.statement_kind='other' from last 90 days.
//   - Embed each statement string via the dream embedder.
//   - Greedy-cluster by cosine ≥ 0.75.
//   - Clusters with ≥ 3 members → one Haiku LLM call proposes new enum entries.
//   - Each proposal writes a rule_candidate with kind='statement_kind_enum'.
//
// FAIL-SOFT: any error here MUST NOT abort the Dream run.

import { parseLLMJSON } from '../biographer/output.js';
import { createCandidate } from './candidates.js';
import { estimateCallCost } from './outcome-grading-prompt.js';
import { greedyCluster } from './prediction-taxonomy-cluster.js';
import { isSelfImprovementV2Enabled } from '../../runtime/config/self-improvement-v2.js';

// Existing enum members — proposals matching any of these are rejected.
const EXISTING_ENUM = new Set([
  'event_timing',
  'outcome_value',
  'duration',
  'preference_guess',
  'fact_recall',
  'behavior_continuation',
  'other',
]);

const VALID_KIND_RE = /^[a-z][a-z0-9_]{2,30}$/;

const WEEKLY_MS = 7 * 24 * 60 * 60 * 1000;
const LOOKBACK_DAYS = 90;
const MIN_CLUSTER = 3;
const SIM_THRESHOLD = 0.75;

/**
 * Read the weekly-cooldown timestamp from runtime:self-improvement-v2.
 * Returns null if not set.
 *
 * @param {import('surrealdb').Surreal} db
 * @returns {Promise<Date|null>}
 */
async function readLastRunAt(db) {
  try {
    const [rows] = await db
      .query('SELECT VALUE value FROM runtime:`self-improvement-v2`')
      .collect();
    const v = rows?.[0];
    if (!v?.prediction_taxonomy_last_run_at) return null;
    return new Date(v.prediction_taxonomy_last_run_at);
  } catch {
    return null;
  }
}

/**
 * Write the weekly-cooldown timestamp.
 *
 * @param {import('surrealdb').Surreal} db
 * @param {Date} ts
 */
async function writeLastRunAt(db, ts) {
  await db
    .query(
      `UPSERT runtime:\`self-improvement-v2\` SET value.prediction_taxonomy_last_run_at = $ts`,
      { ts },
    )
    .collect();
}

/**
 * Prompt for the single Haiku call. Receives cluster summaries and produces
 * JSON: an array of { proposed_kind, description, source_prediction_ids }.
 */
function buildPrompt(clusterSummaries) {
  const clustersText = clusterSummaries
    .map(
      (c, i) =>
        `Cluster ${i + 1} (${c.ids.length} predictions):\n${c.statements.map((s) => `  - ${s}`).join('\n')}`,
    )
    .join('\n\n');

  return `You are helping improve a prediction-tracking system. The system records predictions about the future using a \`statement_kind\` enum to categorize them. The current enum values are: ${[...EXISTING_ENUM].filter((k) => k !== 'other').join(', ')}.

The following clusters of predictions were tagged \`kind='other'\` because they didn't fit any existing category. For each cluster, propose a new snake_case \`statement_kind\` identifier that would fit these predictions.

Rules:
- Identifier must be snake_case, 3–31 characters, starting with a letter: /^[a-z][a-z0-9_]{2,30}$/
- Do not reuse any existing enum value
- Keep it generic enough to describe the cluster, not just one prediction

${clustersText}

Respond with JSON only — an array of objects, one per cluster, in the same order:
[
  {
    "proposed_kind": "snake_case_identifier",
    "description": "One-line description of what this kind represents.",
    "source_prediction_ids": ["id1", "id2", ...]
  }
]`;
}

/**
 * Weekly dream step — cluster 'other' predictions and propose new enum entries.
 *
 * @param {import('surrealdb').Surreal} db
 * @param {object} host — dream host with invokeLLM
 * @param {object} embedder — embedder with .embed(text) → Float32Array
 * @param {object} [opts]
 * @param {number} [opts.similarityThreshold=0.75]
 * @param {number} [opts.minCluster=3]
 * @param {number} [opts.lookbackDays=90]
 * @returns {Promise<object>}
 */
export async function dreamStepPredictionTaxonomy(db, host, embedder, opts = {}) {
  const {
    similarityThreshold = SIM_THRESHOLD,
    minCluster = MIN_CLUSTER,
    lookbackDays = LOOKBACK_DAYS,
  } = opts;

  if (!(await isSelfImprovementV2Enabled(db))) {
    return { skipped: true, reason: 'v2_not_enabled', step: 'predictionTaxonomy' };
  }

  // Weekly cooldown gate.
  const lastRunAt = await readLastRunAt(db);
  if (lastRunAt && Date.now() - lastRunAt.getTime() < WEEKLY_MS) {
    const nextRunAt = new Date(lastRunAt.getTime() + WEEKLY_MS).toISOString();
    return { skipped: true, reason: 'weekly_cooldown', next_run_at: nextRunAt, step: 'predictionTaxonomy' };
  }

  // Read kind='other' predictions from last 90 days.
  const cutoff = new Date(Date.now() - lookbackDays * 86_400_000);
  let predictions;
  try {
    const [rows] = await db
      .query(
        `SELECT id, content, derived_at FROM memos
         WHERE kind = 'prediction'
           AND meta.statement_kind = 'other'
           AND derived_at >= $cutoff
         ORDER BY derived_at DESC
         LIMIT 500`,
        { cutoff },
      )
      .collect();
    predictions = rows ?? [];
  } catch (e) {
    console.warn(`[step-prediction-taxonomy] DB read failed: ${e.message}`);
    return { skipped: false, error: 'db_read_failed', step: 'predictionTaxonomy' };
  }

  if (predictions.length === 0) {
    await writeLastRunAt(db, new Date()).catch(() => {});
    return {
      skipped: false,
      eligible_clusters: 0,
      proposed_kinds: [],
      candidates_written: 0,
      cost_usd: 0,
      step: 'predictionTaxonomy',
    };
  }

  // Embed each prediction statement.
  const items = [];
  for (const pred of predictions) {
    try {
      const vec = await embedder.embed(pred.content);
      items.push({ id: pred.id, statement: pred.content, embedding: vec });
    } catch (e) {
      console.warn(`[step-prediction-taxonomy] embedder failed for ${pred.id}: ${e.message}`);
      // Embedder error — return early per spec.
      return { skipped: false, error: 'embedder_failed', step: 'predictionTaxonomy' };
    }
  }

  // Greedy cluster by cosine ≥ threshold.
  const rawClusters = greedyCluster(items, similarityThreshold);

  // Build a lookup from id → statement for prompt building.
  const statementById = new Map(items.map((it) => [String(it.id), it.statement]));

  // Eligible clusters: size ≥ minCluster.
  const eligible = rawClusters
    .filter((c) => c.ids.length >= minCluster)
    .map((c) => ({
      ids: c.ids.map(String),
      statements: c.ids.map((id) => statementById.get(String(id)) ?? ''),
    }));

  if (eligible.length === 0) {
    await writeLastRunAt(db, new Date()).catch(() => {});
    return {
      skipped: false,
      eligible_clusters: 0,
      proposed_kinds: [],
      candidates_written: 0,
      cost_usd: 0,
      step: 'predictionTaxonomy',
    };
  }

  // Single LLM call for all eligible clusters.
  let proposals;
  let tokensIn = 0;
  let tokensOut = 0;
  try {
    const userPrompt = buildPrompt(eligible);
    const r = await host.invokeLLM([{ role: 'user', content: userPrompt }], {
      tier: 'fast',
      json: true,
    });
    tokensIn = r?.usage?.input_tokens ?? 0;
    tokensOut = r?.usage?.output_tokens ?? 0;
    const parsed = parseLLMJSON(r.content);
    if (!Array.isArray(parsed)) {
      console.warn('[step-prediction-taxonomy] LLM returned non-array JSON');
      return {
        skipped: false,
        eligible_clusters: eligible.length,
        llm_error: 'malformed_response',
        step: 'predictionTaxonomy',
      };
    }
    proposals = parsed;
  } catch (e) {
    console.warn(`[step-prediction-taxonomy] LLM call failed: ${e.message}`);
    return {
      skipped: false,
      eligible_clusters: eligible.length,
      llm_error: 'malformed_response',
      step: 'predictionTaxonomy',
    };
  }

  // Validate + write one rule_candidate per valid proposal.
  let candidatesWritten = 0;
  const proposedKinds = [];
  for (const proposal of proposals) {
    const { proposed_kind, description, source_prediction_ids } = proposal ?? {};
    // Validate shape.
    if (
      typeof proposed_kind !== 'string' ||
      !VALID_KIND_RE.test(proposed_kind) ||
      EXISTING_ENUM.has(proposed_kind)
    ) {
      continue;
    }
    if (typeof description !== 'string' || description.trim().length === 0) {
      continue;
    }
    const sourceIds = Array.isArray(source_prediction_ids)
      ? source_prediction_ids.map(String).filter(Boolean)
      : [];
    const count = sourceIds.length || 1;

    try {
      await createCandidate(db, {
        content: `Propose new statement_kind enum entry: '${proposed_kind}'\n\nDescription: ${description.trim()}\n\nEvidence: ${count} predictions clustered.`,
        kind: 'statement_kind_enum',
        signal_events: [],
        confidence: 0.7,
        payload: { proposed_kind, description: description.trim(), source_prediction_ids: sourceIds },
      });
      proposedKinds.push(proposed_kind);
      candidatesWritten++;
    } catch (e) {
      console.warn(`[step-prediction-taxonomy] candidate write failed for ${proposed_kind}: ${e.message}`);
    }
  }

  const costUsd = estimateCallCost(tokensIn, tokensOut);
  await writeLastRunAt(db, new Date()).catch(() => {});

  return {
    skipped: false,
    eligible_clusters: eligible.length,
    proposed_kinds: proposedKinds,
    candidates_written: candidatesWritten,
    cost_usd: costUsd,
    step: 'predictionTaxonomy',
  };
}
