// step-calibration-bucket.js — Dream step: compute confidence_band memos.
// L2 step, pure math. Sole writer of `confidence_band` memos.
// Spec §4b: adaptive per-bucket calibration math with Laplace smoothing.
// FAIL-SOFT: an error here MUST NOT abort the Dream run.
//
// Transaction safety: the delete+create cycle for each statement_kind is wrapped
// in a single BEGIN TRANSACTION / COMMIT TRANSACTION block so the sole-writer
// property is genuinely atomic (replaces the previous Promise.all-of-separate-queries
// pattern which was not atomic).
import { BoundQuery } from 'surrealdb';
import { isSelfImprovementV2Enabled } from '../../runtime/config/self-improvement-v2.js';
import {
  computeBuckets,
  VALID_STATEMENT_KINDS,
} from './calibration-bucket-math.js';

export async function dreamStepCalibrationBucket(db) {
  if (!(await isSelfImprovementV2Enabled(db))) {
    return { skipped: true, reason: 'v2_not_enabled', step: 'calibrationBucket' };
  }

  try {
    return await runCalibrationBucket(db);
  } catch (e) {
    console.warn(`[dream] step-calibration-bucket: ${e.message}`);
    return { skipped: false, ok: false, reason: e.message, step: 'calibrationBucket' };
  }
}

// ---------------------------------------------------------------------------
// Core logic — split out for testability.
// ---------------------------------------------------------------------------

export async function runCalibrationBucket(db) {
  const now = new Date();

  // 1. Read all resolved predictions (excluding kind='other').
  const [rows] = await db
    .query(
      `SELECT confidence, meta.correct AS correct, meta.statement_kind AS statement_kind
       FROM memos
       WHERE kind = 'prediction'
         AND meta.resolved_at IS NOT NONE`,
    )
    .collect();

  // 2. Group by statement_kind, skip 'other' and unknown kinds.
  const byKind = new Map();
  for (const row of rows ?? []) {
    const sk = row.statement_kind;
    if (!sk || sk === 'other') continue;
    if (!VALID_STATEMENT_KINDS.has(sk)) {
      console.warn(`[dream] step-calibration-bucket: unknown statement_kind '${sk}', skipping`);
      continue;
    }
    if (!byKind.has(sk)) byKind.set(sk, []);
    byKind.get(sk).push({ confidence: row.confidence ?? 0, correct: row.correct === true });
  }

  let kinds_processed = 0;
  let buckets_written = 0;
  const bucketing_modes = { bootstrap: 0, mature: 0 };

  // 3. For each kind: delete existing confidence_band rows + rewrite atomically.
  //
  //    Pattern from system/cognition/memory/store.js (relateAll) and
  //    system/data/db/migrate.js: build a single BoundQuery string with
  //    BEGIN TRANSACTION / COMMIT TRANSACTION and per-index bindings, then
  //    execute in one db.query() call. This is the canonical SurrealDB approach
  //    for a variable-length atomic batch and replaces the previous
  //    Promise.all-of-separate-queries pattern (not actually atomic).
  for (const [statement_kind, predictions] of byKind) {
    const buckets = computeBuckets(predictions);
    if (buckets.length === 0) continue;

    // Build the transaction: DELETE + one CREATE per bucket.
    // Use per-index binding keys (f0, f1, …) to avoid collisions.
    const txB = { sk: statement_kind };
    const txL = [
      'BEGIN TRANSACTION',
      `DELETE memos WHERE kind = 'confidence_band' AND meta.statement_kind = $sk`,
    ];
    for (let i = 0; i < buckets.length; i++) {
      const b = buckets[i];
      const label =
        b.bucketing_mode === 'bootstrap'
          ? `${statement_kind} @ ${b.bucket}`
          : `${statement_kind} @ ${String(b.bucket.toFixed(1))}`;
      const content = `${label}: ${b.correct}/${b.n} correct, accuracy=${b.accuracy.toFixed(3)} (laplace), raw=${b.raw_accuracy === null ? 'n/a' : b.raw_accuracy.toFixed(3)}`;
      txB[`f${i}`] = {
        kind: 'confidence_band',
        content,
        derived_by: 'dream',
        scope: 'global',
        tags: [],
        meta: {
          statement_kind,
          bucket: b.bucket,
          bucketing_mode: b.bucketing_mode,
          n: b.n,
          correct: b.correct,
          accuracy: b.accuracy,
          raw_accuracy: b.raw_accuracy,
          last_recomputed_at: now,
        },
      };
      txL.push(`CREATE memos CONTENT $f${i}`);
    }
    txL.push('COMMIT TRANSACTION');

    try {
      await db.query(new BoundQuery(txL.join(';\n'), txB)).collect();
    } catch (e) {
      console.warn(
        `[dream] step-calibration-bucket: write failed for ${statement_kind}: ${e.message}`,
      );
      continue;
    }

    kinds_processed += 1;
    buckets_written += buckets.length;
    const mode = buckets[0].bucketing_mode;
    bucketing_modes[mode] = (bucketing_modes[mode] ?? 0) + 1;
  }

  return {
    skipped: false,
    kinds_processed,
    buckets_written,
    bucketing_modes,
    step: 'calibrationBucket',
  };
}
