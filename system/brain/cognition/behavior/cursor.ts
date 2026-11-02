import { createKvStore } from '../../../integrations/_runtime/kv.ts';
import type { RobinDb } from '../../memory/db.ts';

/**
 * Behavioral Habit Inference (Phase 2) — cursor persistence.
 * Design ref: docs/design/2026-06-17-behavioral-habit-inference-design.md §5.
 *
 * Tier A (nightly reinforce) and Tier B (weekly synthesis) each maintain an INDEPENDENT
 * event-id cursor over the `events` firehose, persisted in `integration_state` under the
 * `behavior` namespace (the existing KV pattern). Decoupled cursors mean the two tiers
 * read the same allowlisted signals at their own cadence with no shared staging table.
 * Cold start = 0 (selectNewSignals treats 0 as "from the beginning", bounded by its limit).
 */

const NS = 'behavior';
const REINFORCE_KEY = 'reinforce_cursor';
const SYNTHESIZE_KEY = 'synthesize_cursor';

function readCursor(db: RobinDb, key: string): number {
  const raw = createKvStore(db, NS).get(key);
  if (raw == null) return 0;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function writeCursor(db: RobinDb, key: string, cursor: number): void {
  createKvStore(db, NS).set(key, String(Math.max(0, Math.trunc(cursor))));
}

/** Tier A's last-processed event id (0 = cold start). */
export function getReinforceCursor(db: RobinDb): number {
  return readCursor(db, REINFORCE_KEY);
}
export function setReinforceCursor(db: RobinDb, cursor: number): void {
  writeCursor(db, REINFORCE_KEY, cursor);
}

/** Tier B's last-processed event id (0 = cold start). */
export function getSynthesizeCursor(db: RobinDb): number {
  return readCursor(db, SYNTHESIZE_KEY);
}
export function setSynthesizeCursor(db: RobinDb, cursor: number): void {
  writeCursor(db, SYNTHESIZE_KEY, cursor);
}
