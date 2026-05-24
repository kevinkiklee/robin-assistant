import type { RobinDb } from '../../../brain/memory/db.ts';
import type { Invariant } from '../types.ts';

// Flag only meaningful drift, not the one-or-two-row lag while embed-backfill is
// mid-batch: warn when indexed rows fall short of embedded content rows by more
// than max(ABS_TOLERANCE, FRACTION × embedded). The historical bug had >99% of
// rows missing from the index; a healthy steady state is ~exact (content +
// vec are written in one transaction per row).
const ABS_TOLERANCE = 10;
const FRACTION_TOLERANCE = 0.02; // 2%

/**
 * events_vec (the sqlite-vec search index) must stay in sync with the canonical
 * embedding store (events_content.embedding). recall()'s vector mode JOINs the
 * two on id == rowid, so missing vec rows silently degrade vector recall to
 * lexical-only without any error. This invariant catches that drift — e.g. after
 * a vec-dimension migration, a partial reindex, or any future writer that forgets
 * to update the index — instead of letting recall quietly rot.
 */
export function vecIndexSyncedInvariant(db: RobinDb): Invariant {
  return {
    name: 'vec.index_synced',
    severity: 'warning',
    symptom:
      'Vector recall returns few/no semantic matches even though content is embedded; recall silently falls back to lexical-only.',
    cause:
      'events_vec (search index) is out of sync with events_content.embedding — e.g. an embedding-dimension migration, an interrupted reindex, or content embedded by an older path that did not populate the index.',
    fix: 'Run `robin reindex --force` to rebuild events_vec from the canonical embeddings.',
    check: () => {
      const embedded = (
        db
          .prepare('SELECT COUNT(*) AS n FROM events_content WHERE embedding IS NOT NULL')
          .get() as { n: number }
      ).n;
      const indexed = (db.prepare('SELECT COUNT(*) AS n FROM events_vec').get() as { n: number }).n;
      const missing = embedded - indexed;
      const tolerance = Math.max(ABS_TOLERANCE, Math.floor(embedded * FRACTION_TOLERANCE));
      if (missing <= tolerance) return { ok: true };
      return {
        ok: false,
        message: `events_vec is missing ${missing} of ${embedded} embedded rows (only ${indexed} indexed)`,
        remediation: 'robin reindex --force',
      };
    },
  };
}
