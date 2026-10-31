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
const SCAN_KEY = 'scan_cursor';

function readCursor(db: RobinDb, key: string): number {
  const raw = createKvStore(db, NS).get(key);
  if (raw == null) return 0;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function writeCursor(db: RobinDb, key: string, cursor: number): void {
  createKvStore(db, NS).set(key, String(Math.max(0, Math.trunc(cursor))));
}

/** The linker's last-processed event id (0 = cold start). */
export function getLinkCursor(db: RobinDb): number {
  return readCursor(db, LINK_KEY);
}

export function setLinkCursor(db: RobinDb, cursor: number): void {
  writeCursor(db, LINK_KEY, cursor);
}

/**
 * The session-scan backfill's last-processed `session.captured` event id (0 = cold start).
 * INDEPENDENT of the linker's `link_cursor`: the deferred LLM backfill (Phase 1.1) re-reads
 * recent sessions to discover recommendations Robin never logged via the `recommend` tool,
 * at its own weekly cadence, so it must not share the nightly deterministic linker's cursor.
 */
export function getScanCursor(db: RobinDb): number {
  return readCursor(db, SCAN_KEY);
}

export function setScanCursor(db: RobinDb, cursor: number): void {
  writeCursor(db, SCAN_KEY, cursor);
}
