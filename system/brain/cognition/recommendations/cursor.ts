import { createKvStore } from '../../../integrations/_runtime/kv.ts';
import type { RobinDb } from '../../memory/db.ts';

/**
 * Recommendation→Action Loop (Phase 1) — the linker's cursor persistence.
 * Design ref: docs/design/2026-06-17-recommendation-loop-design.md §5.
 *
 * The retroactive linker (`recommendation-link.run`) maintains its OWN event-id cursor
 * over the `events` firehose, independent of Phase 2's reinforce/synthesize cursors so
 * it scans behavioral signals at its own cadence with no shared staging. Persisted in
 * `integration_state` under the `recommendations` namespace (the existing KV pattern,
 * mirroring behavior/cursor.ts). Cold start = 0 (selectNewSignals treats 0 as "from the
 * beginning", bounded by its limit).
 */

const NS = 'recommendations';
const LINK_KEY = 'link_cursor';

/** The linker's last-processed event id (0 = cold start). */
export function getLinkCursor(db: RobinDb): number {
  const raw = createKvStore(db, NS).get(LINK_KEY);
  if (raw == null) return 0;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

export function setLinkCursor(db: RobinDb, cursor: number): void {
  createKvStore(db, NS).set(LINK_KEY, String(Math.max(0, Math.trunc(cursor))));
}
