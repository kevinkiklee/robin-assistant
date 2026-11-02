import { clockDate } from '../../lib/clock.ts';
import type { LLMDispatcher } from '../llm/dispatcher.ts';
import { believe, recallBelief } from '../memory/belief.ts';
import type { RobinDb } from '../memory/db.ts';

export interface ApplyCorrectionsResult {
  processed: number;
  retracted: number;
  /** Corrected values written back as live belief heads (never leave a topic headless). */
  asserted: number;
}

/**
 * Apply topic-linked corrections to the belief substrate.
 *
 * This is the ONE sanctioned auto-repair path for beliefs: only corrections
 * that name an explicit `topic` (set via `record_correction`) are replayed.
 * Global / behavioral corrections (NULL topic) are deliberately left untouched —
 * they are not belief-targeted and require human or handler review before any
 * action is taken. No fuzzy matching; every retraction here is traceable to an
 * exact, user-supplied topic link.
 *
 * For each unapplied, topic-linked correction:
 *   1. Look up the live belief head via `recallBelief`.
 *   2. If a non-retracted head exists, write a first-party retraction:
 *      `believe(..., { retracted: true, provenance: 'first-party', supersedes: head.eventId })`.
 *      First-party provenance carries the highest authority (the operator's explicit correction),
 *      and superseding-with-retracted removes the false claim from the primer (which
 *      filters retracted heads when building context).
 *   3. Assert the CORRECTED value as a new live head (see below).
 *   4. Whether or not a belief head existed, mark the correction `applied = 1`
 *      so it is not reprocessed on the next run.
 *
 * Step 3 exists because retract-without-replace left the topic HEADLESS, which made
 * a corrected topic *more* vulnerable to the falsehood coming back rather than less:
 * `promoteStableCandidates` only checks candidates against NON-retracted heads, so
 * once the only head was retracted there was nothing left to contradict, and the
 * biographer's next re-derivation of the stale claim sailed through to `promoted`.
 * That is the mechanism that brought back a stale claim (a correction) and
 * a stale ownership claim (another correction). Measured 2026-08-10: 10 of 50
 * corrected topics had no live head. Writing the correction back as a first-party
 * head closes the loop — `recallBelief` now returns the truth for a corrected topic,
 * and the existing contradiction check has something authoritative to test against.
 *
 * Errors on individual rows are caught and skipped (best-effort batch). A single
 * bad correction row will never abort the loop.
 */
export function applyCorrections(
  db: RobinDb,
  llm: LLMDispatcher | null,
  now: Date = clockDate(),
): ApplyCorrectionsResult {
  const rows = db
    .prepare(
      `SELECT id, topic, correction FROM corrections WHERE applied = 0 AND topic IS NOT NULL`,
    )
    .all() as Array<{ id: number; topic: string; correction: string }>;

  let processed = 0;
  let retracted = 0;
  let asserted = 0;

  const markApplied = db.prepare(`UPDATE corrections SET applied = 1 WHERE id = ?`);

  for (const row of rows) {
    try {
      const head = recallBelief(db, { topic: row.topic });
      const record = head && !Array.isArray(head) ? head : null;

      // What the corrected head must supersede: the retraction if we write one,
      // otherwise whatever head already stood (possibly an older retraction).
      let supersedeTarget: number | null = record?.eventId ?? null;

      if (record && !record.retracted) {
        const retraction = believe(db, llm, {
          topic: row.topic,
          claim: record.claim,
          confidence: record.confidence ?? undefined,
          retracted: true,
          supersedes: record.eventId,
          provenance: 'first-party',
          verifiedAt: now.toISOString(),
        });
        retracted++;
        supersedeTarget = retraction.eventId;
      }

      // Assert the corrected value so the topic is never left headless. The operator's
      // own words are the claim — no paraphrase, no inference. `first-party` at
      // near-certain confidence because an explicit correction is the highest
      // authority the store has.
      //
      // This MUST supersede rather than plain-set: a plain set shares the
      // `belief:<date>:<topic>` same-day idempotency key with the head being
      // corrected, so it upserts that row IN PLACE — leaving the retraction with
      // a higher id, superseding the corrected claim, and winning `ORDER BY ts
      // DESC, id DESC` on any same-millisecond tie. Superseding the retraction
      // keys the write as `...:s<id>`, which appends and orders last.
      const corrected = row.correction?.trim();
      if (corrected) {
        believe(db, llm, {
          topic: row.topic,
          claim: corrected,
          confidence: 0.99,
          supersedes: supersedeTarget ?? undefined,
          provenance: 'first-party',
          verifiedAt: now.toISOString(),
        });
        asserted++;
      }

      markApplied.run(row.id);
      processed++;
    } catch {
      // Skip bad rows; don't abort the whole batch.
    }
  }

  return { processed, retracted, asserted };
}
