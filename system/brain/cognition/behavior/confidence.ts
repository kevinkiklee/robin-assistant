/**
 * Behavioral Habit Inference (Phase 2) — confidence as a PURE function of state.
 * Design ref: docs/design/2026-06-17-behavioral-habit-inference-design.md §6.
 *
 * `confidence` is NOT an incrementally-mutated counter (which would sawtooth against
 * reinforcement). It is recomputed from stored state every Tier A pass:
 *
 *   confidence = f(support_count, support_streams, age(last_reinforced), contradiction_count)
 *
 * Properties (asserted in confidence.test.ts):
 *  - monotone non-decreasing in support_count and support_streams,
 *  - decaying with the age of last_reinforced,
 *  - penalized (non-increasing) by contradiction_count,
 *  - always clamped to [0, 1],
 *  - deterministic (no clock reads, no randomness — `now` is an explicit input).
 *
 * The LLM proposes the *pattern*; the engine owns the *number*. This sidesteps the
 * LLM-self-rating miscalibration seen in dream-synthesis.
 *
 * --- Constants (conservative by design; §13 says start conservative, tune from the
 *     learning-digest) ---
 */

/**
 * Per-signal support weight. Support is summed with diminishing returns
 * (`1 - exp(-k * support)`) so the first few corroborating signals matter most and a
 * runaway count can't dominate the score. At the §8 graduation default K=4 the raw
 * support term reaches ~1 - exp(-0.55*4) ≈ 0.89, leaving recency + multi-stream the
 * decisive factors — deliberate: a single-stream pile of signals stays sub-graduation.
 */
const SUPPORT_K = 0.55;

/**
 * Multi-stream bonus weight. A pattern seen across ≥2 distinct streams is far stronger
 * than the same count from one stream (the spec's whole creation floor, §7). We scale
 * the support term by a stream multiplier in [STREAM_FLOOR, 1]: one stream is heavily
 * discounted, two+ streams unlock the full support term.
 */
const STREAM_FLOOR = 0.55;

/**
 * Recency half-life in days. Confidence decays multiplicatively with the age of
 * last_reinforced: `0.5 ** (ageDays / HALF_LIFE_DAYS)`. 45 days is conservative — a
 * habit unreinforced for ~6 weeks loses half its strength, for ~3 months loses ~75%,
 * which is what drives the Tier-A staleness retire.
 */
const HALF_LIFE_DAYS = 45;

/**
 * Per-contradiction penalty (multiplicative). Each contradiction multiplies confidence
 * by (1 - CONTRADICTION_PENALTY); contradictions are a demotion signal (§8), so the
 * penalty is meaningful but bounded — it can never by itself push a well-supported,
 * recent habit to zero.
 */
const CONTRADICTION_PENALTY = 0.2;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface ConfidenceInput {
  /** # distinct supporting signals. */
  supportCount: number;
  /** # distinct streams contributing. */
  supportStreams: number;
  /** When the habit was last reinforced (Date or ISO/SQLite-utc string). */
  lastReinforcedAt: Date | string;
  /** Best-effort contradiction tally. */
  contradictionCount: number;
  /** Reference "now" — explicit so the function stays deterministic/testable. */
  now: Date;
}

/** Coerce a Date | string timestamp to epoch ms; invalid/empty → 0 (treated as ancient). */
function toMs(t: Date | string): number {
  if (t instanceof Date) return t.getTime();
  // SQLite's `datetime('now')` form ("YYYY-MM-DD HH:MM:SS", UTC) lacks a zone marker;
  // append 'Z' so Date parses it as UTC rather than local time.
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(t)
    ? `${t.replace(' ', 'T')}Z`
    : t;
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * Recompute a habit's confidence in [0, 1] from its stored state. Pure: same inputs →
 * same output, no clock or RNG reads.
 */
export function computeConfidence(input: ConfidenceInput): number {
  const support = Math.max(0, input.supportCount);
  const streams = Math.max(0, input.supportStreams);
  const contradictions = Math.max(0, input.contradictionCount);

  // 1. Support term with diminishing returns — monotone non-decreasing in support.
  const supportTerm = 1 - Math.exp(-SUPPORT_K * support);

  // 2. Multi-stream multiplier — one stream is discounted to STREAM_FLOOR, ≥2 streams
  //    get the full term. Linear ramp between is monotone non-decreasing in streams.
  const streamMultiplier = streams >= 2 ? 1 : streams <= 0 ? 0 : STREAM_FLOOR;

  // 3. Recency decay — multiplicative half-life on the age of last_reinforced.
  const ageDays = Math.max(0, (input.now.getTime() - toMs(input.lastReinforcedAt)) / MS_PER_DAY);
  const recency = 0.5 ** (ageDays / HALF_LIFE_DAYS);

  // 4. Contradiction penalty — multiplicative, bounded ≥ 0.
  const penalty = (1 - CONTRADICTION_PENALTY) ** contradictions;

  const raw = supportTerm * streamMultiplier * recency * penalty;
  // Clamp [0, 1] (the factors are already within range, but clamp defensively).
  return Math.min(1, Math.max(0, raw));
}
