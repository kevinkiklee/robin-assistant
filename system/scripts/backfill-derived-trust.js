// system/scripts/backfill-derived-trust.js
//
// One-shot backfill that stamps `derived_from_trust` on all rows that
// predate the 0034-trust-propagation migration.  Safe to re-run (idempotent).
//
// Ordering matters:
//   1. entities / memos — cite events directly via provenance.event_ids
//   2. edges            — inherit from endpoint entities (must run after 1)
//   3. episodes         — inherit from their member events via back-ref
//   4. arcs             — inherit from episode ids stored in meta.episode_ids
//
// If a table doesn't exist in the in-memory fixture the SELECT returns []
// and the loop is a no-op (safe for unit tests that only define some tables).
import { StringRecordId } from 'surrealdb';
import { mergeTrust } from '../cognition/discretion/wrap-untrusted.js';

/**
 * Coerce a mixed array of string / RecordId values to StringRecordId so
 * SurrealDB's `WHERE id IN $ids` binding matches the record's ID type.
 * String values like 'events:u1' must be wrapped; non-strings are passed
 * through as-is (they're already typed).
 */
function toRecordIds(ids) {
  return (ids ?? []).map(id =>
    typeof id === 'string' ? new StringRecordId(id) : id
  );
}

/**
 * Look up the `trust` field for a list of event record IDs and merge them
 * into a single trust value.  Returns 'trusted' if the list is empty.
 */
async function trustOfEvents(db, eventIds) {
  if (!eventIds || eventIds.length === 0) return 'trusted';
  const [rows] = await db
    .query(`SELECT trust FROM events WHERE id IN $ids`, { ids: toRecordIds(eventIds) })
    .collect();
  return mergeTrust(rows.map(r => r.trust ?? 'trusted'));
}

/**
 * Backfill `derived_from_trust` for a table that stores its source event IDs
 * in a single field.
 *
 * @param {object} db            - SurrealDB client
 * @param {string} table         - table name
 * @param {string} eventIdsField - field that holds the event ID array.
 *   For entities/memos this is 'provenance' (object with .event_ids inside).
 *   For episodes this is 'event_ids' (direct array — resolved via back-ref
 *   at the caller level instead, but we keep this path generic).
 */
async function backfillTable(db, table, eventIdsField) {
  let rows;
  try {
    [rows] = await db
      .query(`SELECT id, ${eventIdsField} AS ev FROM ${table}`)
      .collect();
  } catch {
    // Table may not exist in minimal test fixtures — treat as empty.
    return;
  }
  if (!Array.isArray(rows)) return;

  for (const r of rows) {
    // provenance is an object { event_ids: [...] }; event_ids is a direct array.
    const ids = Array.isArray(r.ev) ? r.ev : (r.ev?.event_ids ?? []);
    const trust = await trustOfEvents(db, ids);
    await db
      .query(`UPDATE ${r.id} SET derived_from_trust = $t`, { t: trust })
      .collect();
  }
}

/**
 * Backfill edges by inheriting the worst trust of their two endpoints
 * (which must already be stamped — run after backfillTable for entities).
 */
async function backfillEdgesFromEntities(db) {
  let edges;
  try {
    [edges] = await db.query(`SELECT id, in, out FROM edges`).collect();
  } catch {
    return;
  }
  if (!Array.isArray(edges)) return;

  for (const e of edges) {
    let endpoints;
    try {
      [endpoints] = await db
        .query(`SELECT derived_from_trust FROM ${e.in}, ${e.out}`)
        .collect();
    } catch {
      endpoints = [];
    }
    const trust = mergeTrust((endpoints ?? []).map(x => x.derived_from_trust ?? 'trusted'));
    await db
      .query(`UPDATE ${e.id} SET derived_from_trust = $t`, { t: trust })
      .collect();
  }
}

/**
 * Backfill episodes by querying the events that belong to each episode via
 * the back-reference (events.episode_id → episodes).  Falls back to the
 * generic backfillTable path if the back-ref field name matches the schema.
 */
async function backfillEpisodes(db) {
  let episodes;
  try {
    [episodes] = await db.query(`SELECT id FROM episodes`).collect();
  } catch {
    return;
  }
  if (!Array.isArray(episodes)) return;

  for (const ep of episodes) {
    let eventRows;
    try {
      // Use SurrealDB back-ref: `<~events` = events whose episode_id = this ep
      [eventRows] = await db
        .query(`SELECT trust FROM events WHERE episode_id = $ep`, {
          ep: typeof ep.id === 'string' ? new StringRecordId(ep.id) : ep.id,
        })
        .collect();
    } catch {
      eventRows = [];
    }
    const trust = mergeTrust((eventRows ?? []).map(r => r.trust ?? 'trusted'));
    await db
      .query(`UPDATE ${ep.id} SET derived_from_trust = $t`, { t: trust })
      .collect();
  }
}

/**
 * Backfill arcs by inheriting from their constituent episodes.
 * Episode IDs are stored in meta.episode_ids (defensive mirror of the
 * arc_contains edges written by step-arcs.js).
 */
async function backfillArcs(db) {
  let arcs;
  try {
    [arcs] = await db.query(`SELECT id, meta.episode_ids AS ep_ids FROM arcs`).collect();
  } catch {
    return;
  }
  if (!Array.isArray(arcs)) return;

  for (const arc of arcs) {
    const epIds = Array.isArray(arc.ep_ids) ? arc.ep_ids : [];
    let epRows;
    try {
      if (epIds.length > 0) {
        [epRows] = await db
          .query(`SELECT derived_from_trust FROM episodes WHERE id IN $ids`, {
            ids: toRecordIds(epIds),
          })
          .collect();
      } else {
        epRows = [];
      }
    } catch {
      epRows = [];
    }
    const trust = mergeTrust((epRows ?? []).map(r => r.derived_from_trust ?? 'trusted'));
    await db
      .query(`UPDATE ${arc.id} SET derived_from_trust = $t`, { t: trust })
      .collect();
  }
}

/**
 * Run the full backfill in dependency order.
 * Safe to call multiple times (idempotent — re-deriving and re-writing the
 * same value is a no-op from the DB's perspective).
 *
 * @param {object} db - connected SurrealDB client
 */
export async function backfillDerivedTrust(db) {
  // entities and memos cite events via provenance.event_ids
  await backfillTable(db, 'entities', 'provenance');
  await backfillTable(db, 'memos', 'provenance');
  // edges inherit from endpoint entities (must run after entities)
  await backfillEdgesFromEntities(db);
  // episodes derive from their member events
  await backfillEpisodes(db);
  // arcs derive from their member episodes (must run after episodes)
  await backfillArcs(db);
}

// CLI entry point — run directly: node system/scripts/backfill-derived-trust.js
if (import.meta.url === `file://${process.argv[1]}`) {
  const { connect, close, defaultDbUrl } = await import('../data/db/client.js');
  const db = await connect({ engine: await defaultDbUrl() });
  try {
    await backfillDerivedTrust(db);
    console.log('backfill complete');
  } finally {
    await close(db);
  }
}
