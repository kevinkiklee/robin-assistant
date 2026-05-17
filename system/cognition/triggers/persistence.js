// DB layer for the trigger engine.
//
// `runtime:trigger_cursor` shape: { last_event_ts: ISO-string, last_event_id: string }
// `trigger_fires` rows: one per attempted fire (ok | skipped | failed).
//
// All functions tolerate missing rows / pre-migration DB by returning safe
// defaults — same pattern as data/runtime/integrations-state.js.

import { surql } from 'surrealdb';

const CURSOR_KEY = 'trigger_cursor';

export async function readTriggerCursor(db) {
  try {
    const [rows] = await db
      .query(surql`SELECT * FROM type::record('runtime', ${CURSOR_KEY})`)
      .collect();
    const v = rows?.[0]?.value;
    if (!v) return { last_event_ts: null, last_event_id: null };
    return {
      last_event_ts: v.last_event_ts ?? null,
      last_event_id: v.last_event_id ?? null,
    };
  } catch {
    return { last_event_ts: null, last_event_id: null };
  }
}

export async function writeTriggerCursor(db, { last_event_ts, last_event_id }) {
  const value = {
    last_event_ts: last_event_ts ?? null,
    last_event_id: last_event_id ?? null,
  };
  await db
    .query(surql`UPSERT type::record('runtime', ${CURSOR_KEY}) SET value = ${value}`)
    .collect();
  return value;
}

export async function recordTriggerFire(db, fire) {
  // fire = { name, status, event_id, duration_ms, error?, reason?, dedup_hash? }
  // SurrealDB note: JS `null` does NOT coerce to NONE for `option<...>` fields.
  // Omit unset option fields entirely (CLAUDE.md operational invariants).
  const row = { name: fire.name, status: fire.status };
  if (fire.event_id != null) row.event_id = fire.event_id;
  if (Number.isFinite(fire.duration_ms)) row.duration_ms = Math.round(fire.duration_ms);
  if (fire.error != null) row.error = fire.error;
  if (fire.reason != null) row.reason = fire.reason;
  if (fire.dedup_hash != null) row.dedup_hash = fire.dedup_hash;
  await db.query(surql`CREATE trigger_fires CONTENT ${row}`).collect();
  return row;
}

export async function lookupLastFire(db, name) {
  const [rows] = await db
    .query(
      surql`SELECT fired_at FROM trigger_fires WHERE name = ${name} AND status = 'ok' ORDER BY fired_at DESC LIMIT 1`,
    )
    .collect();
  const row = rows?.[0];
  if (!row?.fired_at) return null;
  const t = row.fired_at instanceof Date ? row.fired_at : new Date(row.fired_at);
  if (Number.isNaN(t.getTime())) return null;
  return { fired_at_ms: t.getTime() };
}

// Fetch the next batch of events strictly after the cursor.
//
// Uses ts-only comparison. SurrealDB datetime is nanosecond-precision so
// collisions are rare; if two events share an exact ts at the tick boundary
// we may miss the second on the boundary tick and pick it up next round (the
// cursor advances past the boundary either way). Tradeoff worth taking for
// query simplicity vs the record-id tiebreak which has cross-type comparison
// pitfalls.
export async function fetchEventsAfter(db, cursor, { limit = 100 } = {}) {
  const sinceTs = cursor?.last_event_ts ?? null;
  const sql = sinceTs
    ? surql`
        SELECT id, source, ts, content, meta
        FROM events
        WHERE ts > ${sinceTs}
        ORDER BY ts ASC, id ASC
        LIMIT ${limit}
      `
    : surql`
        SELECT id, source, ts, content, meta
        FROM events
        ORDER BY ts ASC, id ASC
        LIMIT ${limit}
      `;
  const [rows] = await db.query(sql).collect();
  return rows ?? [];
}
