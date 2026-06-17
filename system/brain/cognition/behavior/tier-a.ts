import { createLogger } from '../../../lib/logging/logger.ts';
import type { RobinDb } from '../../memory/db.ts';
import { computeConfidence } from './confidence.ts';
import { getReinforceCursor, setReinforceCursor } from './cursor.ts';
import {
  listHabits,
  recomputeConfidenceFor,
  setHabitStatus,
  updateHabitReinforcement,
} from './habits-store.ts';
import { selectNewSignals } from './signals.ts';
import type { BehavioralSignal, Habit } from './types.ts';

/**
 * Behavioral Habit Inference (Phase 2) — Tier A: nightly, deterministic, NO LLM.
 * Design ref: docs/design/2026-06-17-behavioral-habit-inference-design.md §5 (Tier A).
 *
 * Tier A runs unconditionally every night and does ONLY deterministic work:
 *  - recompute every soft/graduated habit's confidence from stored state (§6),
 *  - retire habits past the staleness / low-confidence floor (→ suppression set),
 *  - high-precision EXACT-ENTITY reinforcement (a signal naming a specific tracked
 *    entity bumps a habit about that entity — no fuzzy/semantic matching here),
 *  - advance the cursor and STAGE new signals for Tier B.
 *
 * Tier A deliberately does NOT create habits (creation floor + semantic attribution are
 * Tier B's job, §7) and does NOT touch `retired` habits beyond leaving them retired.
 */

const log = createLogger({ module: 'behavior' });

/**
 * Max new signals to pull per Tier A pass. Bounds the per-night scan over the events
 * firehose (the engine must never scan the whole stream, §3); this is Tier A's own
 * limit on `selectNewSignals`. Tier B keeps an independent cursor/limit.
 */
const SIGNAL_LIMIT = 500;

/**
 * Retire floor — confidence ceiling. A habit is eligible for retirement only when its
 * (freshly recomputed) confidence has decayed below this. Conservative by design (§13
 * "start conservative"): well below any plausible graduation floor, so an active habit
 * is never retired for a transient dip. Paired with the staleness window below — BOTH
 * must hold, so a low-but-recently-reinforced habit survives.
 */
const RETIRE_CONFIDENCE_FLOOR = 0.12;

/**
 * Retire floor — staleness window in days. A habit is eligible for retirement only when
 * it has gone unreinforced for at least this long. At the confidence half-life of 45d
 * (confidence.ts), ~120 days is ~2.7 half-lives, by which a 2-stream habit has lost the
 * large majority of its strength — the natural pairing with the confidence floor above.
 */
const RETIRE_STALENESS_DAYS = 120;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Outcome of one Tier A (deterministic reinforcement) pass. */
export interface BehaviorReinforceResult {
  /** Habits whose confidence was recomputed from state. */
  confidenceRecomputed: number;
  /** Habits retired this pass (staleness/low-confidence floor). */
  retired: number;
  /** Exact-entity reinforcements applied. */
  reinforced: number;
  /** New behavioral signals staged for the next Tier B pass. */
  staged: number;
  /** The event-id cursor after this pass. */
  cursor: number;
  /** True when the engine was disabled (behavior.enabled = false) and did nothing. */
  skipped: boolean;
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
 * Tokenize a habit statement into a Set of lowercase words for exact-entity matching.
 * Punctuation is stripped to spaces so an entity abutting punctuation still matches
 * word-by-word; the multi-word phrase check (see `statementContainsEntity`) uses the
 * same normalized string.
 */
function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * High-precision EXACT-ENTITY match (§5.A.3): does the habit statement contain the
 * signal's `object` as a specific named entity? Conservative by design — NO fuzzy or
 * semantic matching (that is exactly the judgment Tier A must not make):
 *  - the object must be a MULTI-TOKEN named entity (≥2 normalized tokens, e.g.
 *    "Voigt 35", "Death Valley", "Whole Foods"). A bare single word is rejected: it is
 *    the over-attribution risk the creation floor warns against (§7) — a habit statement
 *    mentioning "gear" or "lens" must NOT be reinforced by every transaction whose
 *    merchant happens to share that common word. Distinguishing a proper noun ("Voigt")
 *    from a generic noun ("gear") is exactly the semantic judgment reserved for Tier B.
 *  - the normalized object phrase must appear as a contiguous whole-word run inside the
 *    normalized statement (word-boundary anchored, so "art" never matches "smart").
 */
function statementContainsEntity(statement: string, object: string): boolean {
  const obj = normalizeText(object);
  if (!obj) return false;
  // ≥2 tokens → a specific named entity. Single words are too ambiguous for Tier A's
  // high-precision-only mandate; they are deferred to Tier B's semantic attribution.
  if (obj.split(' ').length < 2) return false;

  const haystack = ` ${normalizeText(statement)} `;
  return haystack.includes(` ${obj} `);
}

/**
 * Tier A — nightly deterministic reinforcement pass. Honors the `enabled` kill-switch,
 * then: recompute confidence for soft+graduated habits, retire stale low-confidence
 * habits, apply exact-entity reinforcement from new signals, and advance+persist the
 * Tier A cursor. NO LLM, deterministic given `opts.now`.
 *
 * @param opts.enabled  Resolved `behavior.enabled` policy (default true).
 * @param opts.now      Injectable reference time for deterministic tests.
 */
export async function runBehaviorReinforce(
  db: RobinDb,
  opts: { enabled?: boolean; now?: Date } = {},
): Promise<BehaviorReinforceResult> {
  const enabled = opts.enabled ?? true;
  if (!enabled) {
    log.info('behavior disabled — skipping Tier A reinforcement');
    return {
      confidenceRecomputed: 0,
      retired: 0,
      reinforced: 0,
      staged: 0,
      cursor: 0,
      skipped: true,
    };
  }

  const now = opts.now ?? new Date();

  // 1 + 2. Recompute confidence for every active (soft + graduated) habit from stored
  //        state (§6), then retire any that fall past BOTH the confidence floor AND the
  //        staleness window. Retired habits are left untouched (their embedding already
  //        sits in the suppression set).
  const active: Habit[] = [...listHabits(db, 'soft'), ...listHabits(db, 'graduated')];
  let confidenceRecomputed = 0;
  let retired = 0;
  for (const habit of active) {
    const confidence = computeConfidence({
      supportCount: habit.supportCount,
      supportStreams: habit.supportStreams,
      lastReinforcedAt: habit.lastReinforced,
      contradictionCount: habit.contradictionCount,
      now,
    });
    recomputeConfidenceFor(db, habit.id, confidence);
    confidenceRecomputed++;

    const ageDays = Math.max(0, (now.getTime() - toMs(habit.lastReinforced)) / MS_PER_DAY);
    if (confidence < RETIRE_CONFIDENCE_FLOOR && ageDays >= RETIRE_STALENESS_DAYS) {
      setHabitStatus(db, habit.id, 'retired');
      retired++;
    }
  }

  // 3. High-precision exact-entity reinforcement. Pull new signals after the Tier A
  //    cursor and, for each, reinforce ONLY soft/graduated habits whose statement
  //    contains the signal's object as a specific named entity. No fuzzy matching.
  //    Re-read the active set so just-retired habits are excluded from reinforcement.
  const cursorBefore = getReinforceCursor(db);
  const { signals, cursor } = selectNewSignals(db, cursorBefore, SIGNAL_LIMIT);
  const reinforceTargets: Habit[] = [...listHabits(db, 'soft'), ...listHabits(db, 'graduated')];
  let reinforced = 0;
  for (const signal of signals) {
    if (!signal.object) continue;
    for (const habit of reinforceTargets) {
      if (!statementContainsEntity(habit.statement, signal.object)) continue;
      reinforceOne(db, habit, signal, now);
      reinforced++;
    }
  }

  // 4. Advance + persist the Tier A cursor. `staged` = count of new signals seen; they
  //    become available to Tier B via ITS own cursor — Tier A writes no staging table.
  setReinforceCursor(db, cursor);

  log.info(
    { confidenceRecomputed, retired, reinforced, staged: signals.length, cursor },
    'behavior Tier A reinforcement complete',
  );

  return {
    confidenceRecomputed,
    retired,
    reinforced,
    staged: signals.length,
    cursor,
    skipped: false,
  };
}

/**
 * Apply one exact-entity reinforcement: bump support/last_reinforced via the store,
 * recording a fresh distinct-stream count when this signal's stream is new to the
 * habit, then recompute that habit's confidence from its new state (§6).
 */
function reinforceOne(db: RobinDb, habit: Habit, signal: BehavioralSignal, now: Date): void {
  // support_streams is monotone here: a brand-new stream nudges it up by one (capped at
  // the signal's stream count of 1 when the habit had none). We can't enumerate the
  // habit's historical streams from state, so conservatively bump only on the first
  // observed stream — keeps a single-stream pile single-stream (the §7 intent).
  const supportStreams = habit.supportStreams === 0 ? 1 : habit.supportStreams;

  updateHabitReinforcement(db, habit.id, {
    addEventId: signal.sourceEventId,
    supportStreams,
    at: now,
  });

  const updated = computeConfidence({
    supportCount: habit.supportCount + 1,
    supportStreams,
    lastReinforcedAt: now,
    contradictionCount: habit.contradictionCount,
    now,
  });
  recomputeConfidenceFor(db, habit.id, updated);
}
