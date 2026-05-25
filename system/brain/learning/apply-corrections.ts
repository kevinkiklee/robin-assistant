import type { LLMDispatcher } from '../llm/dispatcher.ts';
import { believe, recallBelief } from '../memory/belief.ts';
import type { RobinDb } from '../memory/db.ts';

export interface ApplyCorrectionsResult {
  processed: number;
  retracted: number;
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
 *      First-party provenance carries the highest authority (Kevin's explicit correction),
 *      and superseding-with-retracted removes the false claim from the primer (which
 *      filters retracted heads when building context).
 *   3. Whether or not a belief head existed, mark the correction `applied = 1`
 *      so it is not reprocessed on the next run.
 *
 * Errors on individual rows are caught and skipped (best-effort batch). A single
 * bad correction row will never abort the loop.
 */
export function applyCorrections(
  db: RobinDb,
  llm: LLMDispatcher | null,
  now: Date = new Date(),
): ApplyCorrectionsResult {
  const rows = db
    .prepare(`SELECT id, topic FROM corrections WHERE applied = 0 AND topic IS NOT NULL`)
    .all() as Array<{ id: number; topic: string }>;

  let processed = 0;
  let retracted = 0;

  const markApplied = db.prepare(`UPDATE corrections SET applied = 1 WHERE id = ?`);

  for (const row of rows) {
    try {
      const head = recallBelief(db, { topic: row.topic });
      const record = head && !Array.isArray(head) ? head : null;

      if (record && !record.retracted) {
        believe(db, llm, {
          topic: row.topic,
          claim: record.claim,
          retracted: true,
          supersedes: record.eventId,
          provenance: 'first-party',
          verifiedAt: now.toISOString(),
        });
        retracted++;
      }

      markApplied.run(row.id);
      processed++;
    } catch {
      // Skip bad rows; don't abort the whole batch.
    }
  }

  return { processed, retracted };
}
