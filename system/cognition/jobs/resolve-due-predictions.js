// resolve-due-predictions.js — heartbeat tick (5 min) for auto-resolving
// predictions whose expected_resolution_at has passed.
//
// Spec §4a: "Resolution is heartbeat-driven, not dream-driven."
// Predictions resolve at their expected_resolution_at; dream only runs calibration
// after resolution, not the resolution itself.
//
// Gate: isSelfImprovementV2Enabled — when false, tick is registered but no-ops.

import { BoundQuery } from 'surrealdb';
import { updateMemoMeta } from '../memory/store.js';
import { resolve as foresightResolve } from '../memory/foresight.js';
import {
  isSelfImprovementV2Enabled,
  getSelfImprovementV2Config,
} from '../../runtime/config/self-improvement-v2.js';

const DEFAULT_GRACE_SECONDS = 300;

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Tick body. Queries for due predictions, dispatches per-kind resolver,
 * and writes back results.
 *
 * @param {{ db: object }} opts
 * @returns {Promise<string>} summary string for job tracking
 */
export async function resolveDuePredictions({ db }) {
  if (!(await isSelfImprovementV2Enabled(db))) {
    return 'skipped=flag_off';
  }

  const graceSecs = await readGraceSeconds(db);
  const due = await queryDuePredictions(db, graceSecs);
  if (due.length === 0) return 'checked=0 resolved=0 needs_user=0';

  let resolved = 0;
  let needsUser = 0;

  for (const prediction of due) {
    try {
      const outcome = await dispatch(db, prediction);
      if (outcome.resolution === 'auto') {
        await writeAutoResolution(db, prediction, outcome);
        resolved += 1;
      } else {
        await writeNeedsUser(db, prediction, outcome);
        needsUser += 1;
      }
    } catch (e) {
      console.warn(`[resolve-due-predictions] failed on ${String(prediction.id)}: ${e.message}`);
    }
  }

  return `checked=${due.length} resolved=${resolved} needs_user=${needsUser}`;
}

export default resolveDuePredictions;

// ---------------------------------------------------------------------------
// DB queries
// ---------------------------------------------------------------------------

async function readGraceSeconds(db) {
  try {
    const cfg = await getSelfImprovementV2Config(db);
    const v = cfg?.prediction_grace_seconds;
    return Number.isInteger(v) && v >= 0 ? v : DEFAULT_GRACE_SECONDS;
  } catch {
    return DEFAULT_GRACE_SECONDS;
  }
}

async function queryDuePredictions(db, graceSecs) {
  // SurrealDB duration::from_secs returns a Duration value.
  // We add it to expected_resolution_at and compare to time::now().
  const sql = `
    SELECT id, content, confidence, derived_at, meta
    FROM memos
    WHERE kind = 'prediction'
      AND meta.resolved_at IS NONE
      AND meta.expected_resolution_at IS NOT NONE
      AND meta.expected_resolution_at + duration::from_secs($grace) <= time::now()
  `;
  const [rows] = await db.query(new BoundQuery(sql, { grace: graceSecs })).collect();
  return (rows ?? []).map(projectPrediction);
}

function projectPrediction(row) {
  const meta = row.meta ?? {};
  return {
    id: row.id,
    statement: row.content,
    kind: meta.statement_kind ?? null,
    confidence: row.confidence,
    predicted_at: row.derived_at,
    expected_resolution_at: meta.expected_resolution_at ?? null,
    resolved_at: meta.resolved_at ?? null,
    correct: meta.correct ?? null,
    actual_outcome: meta.actual_outcome ?? null,
    meta,
    _raw: row,
  };
}

// ---------------------------------------------------------------------------
// Write-back helpers
// ---------------------------------------------------------------------------

async function writeAutoResolution(db, prediction, outcome) {
  await foresightResolve(db, prediction.id, {
    correct: outcome.correct,
    actual_outcome: outcome.actual_outcome ?? 'auto-resolved: evidence found',
  });
}

async function writeNeedsUser(db, prediction, outcome) {
  await updateMemoMeta(db, prediction.id, {
    resolution_status: 'needs_user',
    surface_in_brief: true,
    needs_user_reason: outcome.reason ?? `${prediction.kind ?? 'unknown'}_requires_user_judgment`,
  });
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

const RESOLVERS = {
  event_timing: resolveEventTiming,
  outcome_value: resolveOutcomeValue,
  duration: resolveDuration,
  fact_recall: needsUser,
  preference_guess: needsUser,
  behavior_continuation: resolveBehaviorContinuation,
  other: needsUser,
};

/**
 * Dispatch to the per-kind resolver. Unknown kinds fall through to needsUser.
 */
async function dispatch(db, prediction) {
  const resolver = RESOLVERS[prediction.kind] ?? needsUser;
  return resolver(db, prediction);
}

// ---------------------------------------------------------------------------
// Per-kind resolvers
// ---------------------------------------------------------------------------

/**
 * event_timing — look for evidence the predicted event occurred.
 *
 * Two evidence sources:
 *   1. runtime_jobs.last_run_at — if the prediction references a job name in
 *      meta.job_name and it ran within ±15 min of expected_resolution_at.
 *   2. events table — any event whose content contains the prediction's
 *      statement keywords and whose ts is within ±15 min of expected_resolution_at.
 *
 * Resolution rules:
 *   - Evidence found within ±15 min window → correct: true
 *   - No evidence and now > expected_resolution_at + 24h → correct: false
 *   - Otherwise → needsUser (still within grace zone or ambiguous)
 */
export async function resolveEventTiming(db, prediction) {
  const expectedAt = prediction.expected_resolution_at
    ? new Date(prediction.expected_resolution_at)
    : null;
  if (!expectedAt) return needsUser(db, prediction);

  const windowMs = 15 * 60_000; // ±15 min
  const windowStart = new Date(expectedAt.getTime() - windowMs);
  const windowEnd = new Date(expectedAt.getTime() + windowMs);

  // Check runtime_jobs if a job_name hint is available.
  const jobName = prediction.meta?.job_name ?? null;
  if (jobName) {
    const [jobRows] = await db
      .query(
        new BoundQuery('SELECT last_run_at FROM runtime_jobs WHERE name = $name LIMIT 1', {
          name: jobName,
        }),
      )
      .collect();
    const lastRun = jobRows?.[0]?.last_run_at;
    if (lastRun) {
      const t = new Date(lastRun);
      if (t >= windowStart && t <= windowEnd) {
        return {
          resolution: 'auto',
          correct: true,
          actual_outcome: `Job '${jobName}' last ran at ${t.toISOString()}, within the ±15 min window`,
        };
      }
    }
  }

  // Check events table for any event near the expected time.
  // Tighten the query with keywords extracted from the prediction statement so
  // that arbitrary unrelated events don't falsely resolve the prediction.
  const keywords = _extractKeywords(prediction.statement ?? '');
  let evtRows;
  if (keywords.length > 0) {
    // Build WHERE … AND content CONTAINS $kN clauses for each keyword token.
    const clauses = keywords.map((_, i) => `content CONTAINS $k${i}`).join(' AND ');
    const bindings = { wstart: windowStart, wend: windowEnd };
    for (let i = 0; i < keywords.length; i++) bindings[`k${i}`] = keywords[i];
    const sql = `SELECT id, ts FROM events WHERE ts >= $wstart AND ts <= $wend AND ${clauses} LIMIT 1`;
    [evtRows] = await db.query(new BoundQuery(sql, bindings)).collect();
    if (!evtRows?.[0]) {
      // Keyword filter produced terms but no match — don't fall back to a
      // content-filterless broad-window query (false positives on unrelated
      // events near expected_resolution_at).  Instead: if past the 24h horizon,
      // auto-resolve false; otherwise defer to user (still within ambiguity window).
      console.warn(
        `[resolve-due-predictions/event_timing] keyword filter (${keywords.join(', ')}) returned no match`,
      );
      const horizon24h = new Date(expectedAt.getTime() + 24 * 60 * 60_000);
      if (new Date() > horizon24h) {
        return {
          resolution: 'auto',
          correct: false,
          actual_outcome: 'No event evidence found within 24h past expected_resolution_at',
        };
      }
      return needsUser(db, prediction);
    }
  } else {
    // No qualifying keywords — broad query (same as before).
    [evtRows] = await db
      .query(
        new BoundQuery('SELECT id, ts FROM events WHERE ts >= $wstart AND ts <= $wend LIMIT 1', {
          wstart: windowStart,
          wend: windowEnd,
        }),
      )
      .collect();
  }
  if (evtRows?.[0]) {
    return {
      resolution: 'auto',
      correct: true,
      actual_outcome: `Event found near expected time: ${String(evtRows[0].id)}`,
    };
  }

  // No evidence found. Past the 24h horizon → mark false.
  const horizon24h = new Date(expectedAt.getTime() + 24 * 60 * 60_000);
  if (new Date() > horizon24h) {
    return {
      resolution: 'auto',
      correct: false,
      actual_outcome: 'No event evidence found within 24h past expected_resolution_at',
    };
  }

  return needsUser(db, prediction);
}

/**
 * outcome_value — look up a named integration data source and compare the
 * value to meta.expected_value ± meta.tolerance.
 *
 * For v1, if meta.evidence_source is absent, route to needsUser.
 */
export async function resolveOutcomeValue(db, prediction) {
  const src = prediction.meta?.evidence_source;
  if (!src) return needsUser(db, prediction);

  const expectedValue = prediction.meta?.expected_value;
  const tolerance = prediction.meta?.tolerance ?? 0;

  if (expectedValue == null) return needsUser(db, prediction);

  // Query the most recent event from the named integration source.
  const [rows] = await db
    .query(
      new BoundQuery(
        'SELECT meta.value AS value, ts FROM events WHERE source = $src ORDER BY ts DESC LIMIT 1',
        { src },
      ),
    )
    .collect();
  const actual = rows?.[0]?.value;
  if (actual == null) return needsUser(db, prediction);

  const numActual = Number(actual);
  const numExpected = Number(expectedValue);
  if (!Number.isFinite(numActual) || !Number.isFinite(numExpected)) {
    return needsUser(db, prediction);
  }

  const correct = Math.abs(numActual - numExpected) <= tolerance;
  return {
    resolution: 'auto',
    correct,
    actual_outcome: `Actual value from '${src}': ${numActual} (expected ${numExpected} ± ${tolerance})`,
  };
}

/**
 * duration — measure time delta between predicted start/stop events.
 * v1: return needsUser if start/stop events aren't structured.
 */
export async function resolveDuration(db, prediction) {
  // v1: structured start/stop events not yet implemented.
  return needsUser(db, prediction);
}

/**
 * behavior_continuation — check integration-recent-activity for continued
 * presence. Recognizes: chrome, spotify, whoop.
 *
 * v1: route all known integrations to needsUser.  The events table does not
 * carry a per-integration tag (no meta.integration_name column), so we can't
 * distinguish chrome vs spotify vs whoop syncs at query time.  Any source='sync'
 * match would satisfy the check regardless of which integration produced it —
 * too coarse to be meaningful.
 *
 * Re-enable per integration when meta.integration_name schema lands.
 */
export async function resolveBehaviorContinuation(db, prediction) {
  return needsUser(db, prediction);
}

/**
 * needsUser — always defers to user judgment.
 */
export function needsUser(_db, prediction) {
  return Promise.resolve({
    resolution: 'needs_user',
    reason: `${prediction.kind ?? 'unknown'}_requires_user_judgment`,
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const STOPWORDS = new Set([
  'a',
  'an',
  'the',
  'and',
  'or',
  'but',
  'in',
  'on',
  'at',
  'to',
  'for',
  'of',
  'with',
  'by',
  'from',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'being',
  'have',
  'has',
  'had',
  'do',
  'does',
  'did',
  'will',
  'would',
  'could',
  'should',
  'may',
  'might',
  'shall',
  'not',
  'that',
  'this',
  'it',
  'its',
  'my',
  'your',
  'their',
  'our',
  'i',
  'you',
  'he',
  'she',
  'we',
  'they',
  'what',
  'which',
  'who',
  'when',
  'where',
  'how',
  'if',
]);

/**
 * Extract 3–5 informative tokens from a prediction statement for use as
 * content-filter keywords in the event_timing resolver.
 *
 * Tokens must be ≥4 chars and not in the stopword list.  Returns an empty
 * array when no qualifying tokens exist (caller falls back to broad query).
 *
 * @param {string} statement
 * @returns {string[]}
 */
export function _extractKeywords(statement) {
  if (typeof statement !== 'string' || !statement.trim()) return [];
  return statement
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 4 && !STOPWORDS.has(t))
    .slice(0, 5);
}
