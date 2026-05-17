// calibration-bucket-math.js — Pure-math helpers for step-calibration-bucket.
// No DB, no LLM, no I/O. Unit-testable in isolation.
//
// Spec §4b: Adaptive bucketing + Laplace smoothing.
//   Bootstrap (n < 30 per kind):  3 coarse buckets — low/mid/high.
//   Mature   (n ≥ 30 per kind):  10 buckets at 0.1 resolution (lower edge).
//   Laplace: accuracy = (correct + 1) / (n + 2).

// ---------------------------------------------------------------------------
// Valid statement_kinds — spec §4a / agents-md.js
// ---------------------------------------------------------------------------
export const VALID_STATEMENT_KINDS = new Set([
  'event_timing',
  'outcome_value',
  'duration',
  'preference_guess',
  'fact_recall',
  'behavior_continuation',
]);

export const BOOTSTRAP_THRESHOLD = 30;

// ---------------------------------------------------------------------------
// Bucketing
// ---------------------------------------------------------------------------

/**
 * Assign a confidence value (0..1) to its bootstrap bucket key.
 * [0, 0.4) → 'low'   [0.4, 0.7) → 'mid'   [0.7, 1.0] → 'high'
 */
export function bootstrapBucket(confidence) {
  if (confidence < 0.4) return 'low';
  if (confidence < 0.7) return 'mid';
  return 'high';
}

/**
 * Assign a confidence value (0..1) to its mature bucket key (lower-edge float).
 * 0.0 → 0.0, 0.1 → 0.1, ..., 0.9 → 0.9.  1.0 collapses into 0.9.
 */
export function matureBucket(confidence) {
  // Clamp to [0, 1].
  const c = Math.max(0, Math.min(1, confidence));
  // 1.0 goes into the 0.9 bucket.
  if (c >= 1.0) return 0.9;
  // Floor to one decimal place using integer math to avoid float drift.
  return Math.floor(c * 10) / 10;
}

/**
 * Determine the bucketing mode for a given total count.
 */
export function bucketingMode(n) {
  return n >= BOOTSTRAP_THRESHOLD ? 'mature' : 'bootstrap';
}

// ---------------------------------------------------------------------------
// Laplace smoothing
// ---------------------------------------------------------------------------

/**
 * Laplace-smoothed accuracy: (correct + 1) / (n + 2).
 * Works for n=0 (returns 0.5).
 */
export function laplaceAccuracy(correct, n) {
  return (correct + 1) / (n + 2);
}

/**
 * Raw accuracy: correct / n.  Returns null when n=0 (avoids division by zero).
 */
export function rawAccuracy(correct, n) {
  if (n === 0) return null;
  return correct / n;
}

// ---------------------------------------------------------------------------
// Bucket aggregation
// ---------------------------------------------------------------------------

/**
 * Given an array of resolved predictions for ONE statement_kind:
 *   [{ confidence: 0..1, correct: boolean }, ...]
 *
 * Returns an array of bucket result objects:
 *   [{
 *     bucket,          // 'low'|'mid'|'high' or 0.0..0.9
 *     bucketing_mode,  // 'bootstrap' | 'mature'
 *     n,
 *     correct,
 *     accuracy,        // Laplace-smoothed
 *     raw_accuracy,    // correct/n (null when n=0)
 *   }, ...]
 *
 * Only returns buckets that have ≥1 prediction in them.
 */
export function computeBuckets(predictions) {
  const n = predictions.length;
  const mode = bucketingMode(n);

  const bucketFn = mode === 'mature' ? matureBucket : bootstrapBucket;

  const acc = new Map(); // bucket key → { n, correct }

  for (const { confidence, correct } of predictions) {
    const key = bucketFn(confidence);
    if (!acc.has(key)) acc.set(key, { n: 0, correct: 0 });
    const entry = acc.get(key);
    entry.n += 1;
    if (correct === true) entry.correct += 1;
  }

  const results = [];
  for (const [bucket, { n: bn, correct: bc }] of acc) {
    results.push({
      bucket,
      bucketing_mode: mode,
      n: bn,
      correct: bc,
      accuracy: laplaceAccuracy(bc, bn),
      raw_accuracy: rawAccuracy(bc, bn),
    });
  }

  return results;
}
