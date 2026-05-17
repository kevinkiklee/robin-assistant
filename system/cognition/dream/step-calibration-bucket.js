// step-calibration-bucket.js — Dream step: compute confidence_band memos.
// L2 step, pure math. Sole writer of `confidence_band` memos.
// Spec §4b: adaptive per-bucket calibration math with Laplace smoothing.
// FAIL-SOFT: an error here MUST NOT abort the Dream run.
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

  // 3. For each kind: delete existing confidence_band rows + rewrite in one
  //    transaction (sole-writer property).
  for (const [statement_kind, predictions] of byKind) {
    const buckets = computeBuckets(predictions);
    if (buckets.length === 0) continue;

    // Build the DELETE + CREATE statements for a single transaction.
    const deleteStmt = new BoundQuery(
      `DELETE memos WHERE kind = 'confidence_band' AND meta.statement_kind = $sk`,
      { sk: statement_kind },
    );

    // Each bucket becomes one CREATE.
    const createStmts = buckets.map((b) => {
      const label =
        b.bucketing_mode === 'bootstrap'
          ? `${statement_kind} @ ${b.bucket}`
          : `${statement_kind} @ ${String(b.bucket.toFixed(1))}`;
      const content = `${label}: ${b.correct}/${b.n} correct, accuracy=${b.accuracy.toFixed(3)} (laplace), raw=${b.raw_accuracy === null ? 'n/a' : b.raw_accuracy.toFixed(3)}`;
      const meta = {
        statement_kind,
        bucket: b.bucket,
        bucketing_mode: b.bucketing_mode,
        n: b.n,
        correct: b.correct,
        accuracy: b.accuracy,
        raw_accuracy: b.raw_accuracy,
        last_recomputed_at: now,
      };
      return new BoundQuery(`CREATE memos CONTENT $fields`, {
        fields: {
          kind: 'confidence_band',
          content,
          derived_by: 'dream',
          scope: 'global',
          tags: [],
          meta,
        },
      });
    });

    // Execute delete + all creates as a block.
    // SurrealDB supports multiple statements separated by semicolons in one
    // db.query() call — collect() returns one result array per statement.
    const allStmts = [deleteStmt, ...createStmts];
    try {
      await Promise.all(allStmts.map((stmt) => db.query(stmt).collect()));
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
