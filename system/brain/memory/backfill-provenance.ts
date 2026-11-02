import { recallBelief } from './belief.ts';
import type { RobinDb } from './db.ts';
import { classifyProvenance } from './provenance.ts';

export interface BackfillProvenanceResult {
  scanned: number;
  updated: number;
}

/**
 * recallBelief defaults to 50 heads; a one-time backfill must see ALL of them.
 * Belief heads are one-per-topic and bounded (dozens–hundreds), so a high cap
 * loads the full set without risk.
 */
const ALL_HEADS = 1_000_000;

/**
 * One-time data-migration: for each live belief head whose provenance is 'unknown' and that
 * has source event ids, reclassify provenance from those sources' kinds and persist in-place.
 *
 * Idempotent: only touches heads that are still 'unknown'. Re-running after a successful pass
 * is a safe no-op (nothing is 'unknown' + has sources anymore).
 */
export function backfillProvenance(db: RobinDb): BackfillProvenanceResult {
  const heads = recallBelief(db, { limit: ALL_HEADS });
  if (!Array.isArray(heads)) return { scanned: 0, updated: 0 };

  let scanned = 0;
  let updated = 0;

  for (const head of heads) {
    scanned++;

    // Only process unknown-provenance heads that have source event ids
    if (head.provenance !== 'unknown' || head.sources.length === 0) continue;

    // Fetch the kinds of all source events
    const placeholders = head.sources.map(() => '?').join(',');
    const rows = db
      .prepare(`SELECT kind FROM events WHERE id IN (${placeholders})`)
      .all(...head.sources) as Array<{ kind: string }>;

    if (rows.length === 0) continue;

    const kinds = rows.map((r) => r.kind);
    const classified = classifyProvenance(kinds);

    // Only update if we can derive something non-unknown
    if (classified === 'unknown') continue;

    db.prepare(`UPDATE events SET payload = json_set(payload, '$.provenance', ?) WHERE id = ?`).run(
      classified,
      head.eventId,
    );
    updated++;
  }

  return { scanned, updated };
}
