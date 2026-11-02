import { createLogger } from '../../../lib/logging/logger.ts';
import { insertBeliefCandidate } from '../../memory/belief-candidate.ts';
import type { RobinDb } from '../../memory/db.ts';
import type { Habit } from './types.ts';

/**
 * Behavioral Habit Inference (Phase 2) — graduation gate.
 * Design ref: docs/design/2026-06-17-behavioral-habit-inference-design.md §8.
 *
 * A `soft` habit graduates only when ALL measurable criteria hold: support_count ≥ K
 * across ≥2 distinct streams, confidence ≥ a high floor, sustained over ≥ X weeks,
 * recency current. Sensitive domains (health/finance/relationships) NEVER auto-graduate
 * (§11). Graduation EMITS a `preferences` belief_candidate into the existing promotion
 * gate (it does not write a belief head directly); `graduated_belief_id` points to it.
 * Retired-suppression is engine-enforced (embedding match), not prompt-trusted.
 */

const log = createLogger({ module: 'behavior' });

/** Domains that may never auto-graduate to a stated preference (§11). */
export const NON_GRADUATING_DOMAINS: ReadonlySet<string> = new Set([
  'health',
  'finance',
  'relationships',
]);

/**
 * High floor on a habit's (engine-owned) confidence before it may graduate. Set above
 * the typical multi-stream-but-young score so graduation needs sustained, recent
 * corroboration — not a single burst. Conservative by design (§8 "graduation is rare"):
 * at the confidence formula's defaults a 2-stream habit needs ~K=4 recent supports to
 * clear this, which is exactly the bar §8 wants the number to encode.
 */
const HIGH_CONFIDENCE_FLOOR = 0.6;

/**
 * Recency gate — a habit must have been reinforced within this many days of `now` to be
 * "recency current" (§8). Decoupled from Tier A's retire-staleness (120d): graduation is
 * a stricter, forward-looking bar, so a habit that hasn't been seen in ~5 weeks is no
 * longer a *current* tendency worth stating, even if it hasn't decayed enough to retire.
 */
const RECENCY_CURRENT_DAYS = 35;

/** Minimum distinct streams — §8 forbids single-stream graduation. */
const MIN_STREAMS = 2;

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MS_PER_WEEK = 7 * MS_PER_DAY;

export interface GraduationCriteria {
  /** behavior.graduationSupport (K). */
  graduationSupport: number;
  /** behavior.graduationWeeks (X). */
  graduationWeeks: number;
  /** Injectable reference time. */
  now: Date;
}

/** Parse a Date | SQLite-utc | ISO timestamp to epoch ms; invalid/empty → 0 (ancient). */
function toMs(t: string): number {
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(t)
    ? `${t.replace(' ', 'T')}Z`
    : t;
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * Decide whether a soft habit meets the graduation gate. Pure predicate (no writes) so
 * it is unit-testable; the actual belief_candidate emission is done by the caller.
 *
 * ALL of the following must hold (§8):
 *  - support_count ≥ K,
 *  - support_streams ≥ 2 (no single-stream graduation),
 *  - confidence ≥ HIGH_CONFIDENCE_FLOOR,
 *  - the observation window (first_seen → now) spans ≥ X weeks (not a one-week spike),
 *  - last_reinforced is within RECENCY_CURRENT_DAYS of now (recency current).
 *
 * `contradiction_count` is deliberately NOT a gate input (§8 — it can't be measured
 * reliably; it is a demotion/retire trigger only).
 */
export function meetsGraduationGate(habit: Habit, criteria: GraduationCriteria): boolean {
  const { graduationSupport, graduationWeeks, now } = criteria;
  const nowMs = now.getTime();

  if (habit.supportCount < graduationSupport) return false;
  if (habit.supportStreams < MIN_STREAMS) return false;
  if (habit.confidence < HIGH_CONFIDENCE_FLOOR) return false;

  // Sustained over ≥ X weeks: the window from first observation to now.
  const firstSeenMs = toMs(habit.firstSeen);
  const ageWeeks = firstSeenMs > 0 ? (nowMs - firstSeenMs) / MS_PER_WEEK : 0;
  if (ageWeeks < graduationWeeks) return false;

  // Recency current: reinforced recently enough to still be a live tendency.
  const ageDays = (nowMs - toMs(habit.lastReinforced)) / MS_PER_DAY;
  if (ageDays > RECENCY_CURRENT_DAYS) return false;

  return true;
}

/**
 * Graduate a habit: emit a `preferences` belief_candidate through the existing promotion
 * gate (so it flows through the normal review/promotion pipeline) and let the caller link
 * it via `graduated_belief_id`. Does NOT write a belief head directly — until that
 * candidate promotes, even a graduated habit is rendered hedged (§8).
 *
 * Provenance is `inferred` (Robin derived the tendency from indirect behavioral signals,
 * not a stated fact). The habit `confidence` rides along so the promotion gate's
 * class-threshold check sees the engine's own soft number.
 *
 * Returns `{ beliefCandidateId }`, or null if the candidate was filtered as a dev/low-
 * quality claim (sentinel id `-1` from the store) so the caller leaves the habit `soft`.
 */
export async function graduateHabit(
  db: RobinDb,
  habit: Habit,
): Promise<{ beliefCandidateId: number } | null> {
  const { id } = insertBeliefCandidate(db, {
    // Topic mirrors the habit's domain so the candidate slots into the right review bucket.
    topic: `habit-${habit.domain}`,
    claim: habit.statement,
    confidence: habit.confidence,
    provenance: 'inferred',
    domain: 'preferences',
  });
  if (id <= 0) {
    log.info(
      { habitId: habit.id },
      'graduateHabit: candidate filtered (low-quality), staying soft',
    );
    return null;
  }
  log.info(
    { habitId: habit.id, beliefCandidateId: id },
    'graduateHabit: emitted preferences candidate',
  );
  return { beliefCandidateId: id };
}
