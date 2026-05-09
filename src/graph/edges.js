import { surql } from 'surrealdb';

const TYPED_ENTITY_EDGE_TYPES = new Set(['works_on', 'participates_in']);
// 'precedes' is event→event, 'mentions'/'about' are event→entity (separate writers).

export async function writeMentionsEdge(db, eventId, entityId, { weight, context } = {}) {
  await db
    .query(surql`RELATE ${eventId}->mentions->${entityId} CONTENT ${{ weight, context }}`)
    .collect();
}

export async function writeAboutEdge(db, eventId, entityId) {
  await db.query(surql`RELATE ${eventId}->about->${entityId}`).collect();
}

// Caller MUST validate edgeType against the closed entity-edge vocabulary;
// the validation here is a defense-in-depth check.
export async function writeTypedEntityEdge(db, fromId, edgeType, toId) {
  if (!TYPED_ENTITY_EDGE_TYPES.has(edgeType)) {
    throw new Error(`writeTypedEntityEdge: edge type "${edgeType}" not in vocabulary`);
  }
  // edgeType is now from a closed set; safe to interpolate.
  const stmt = `RELATE $from->${edgeType}->$to`;
  await db.query(stmt, { from: fromId, to: toId }).collect();
}

// Stable key from a record id like 'entities:abc' → 'abc'. Accepts string ids
// or RecordId-shaped objects (with .id field) as returned by the SDK.
function idKey(id) {
  if (id && typeof id === 'object' && 'id' in id) return String(id.id);
  return String(id).split(':').slice(1).join(':');
}

// Writes co_occurrence edges between every ordered pair drawn from the top
// `cap` entities. Uses a deterministic record ID per (from, to) so repeated
// calls UPSERT into the same edge, incrementing strength and bumping
// last_seen. With N capped entities → N×(N-1) directional edges.
//
// Pattern: SELECT-by-stable-id, then either UPDATE or RELATE. The RELATE
// statement carries the same stable id we look up by, so the next call's
// SELECT lands on it. UPSERT directly on a TYPE RELATION ENFORCED table is
// rejected by SurrealDB v3 (it bypasses the relation contract that requires
// `in`/`out` to flow through RELATE), hence the check-then-write fallback.
export async function writeCoOccursWith(db, entityIds, { cap = 8 } = {}) {
  const top = entityIds.slice(0, cap);
  if (top.length < 2) return;
  for (let i = 0; i < top.length; i++) {
    for (let j = 0; j < top.length; j++) {
      if (i === j) continue;
      const a = top[i];
      const b = top[j];
      const key = `${idKey(a)}__${idKey(b)}`;
      const [existing] = await db
        .query(surql`SELECT id, strength FROM type::record('co_occurs_with', ${key})`)
        .collect();
      const found = Array.isArray(existing) ? existing[0] : existing;
      if (found) {
        await db
          .query(surql`UPDATE ${found.id} SET strength = strength + 1, last_seen = time::now()`)
          .collect();
      } else {
        await db
          .query(
            surql`RELATE ${a}->co_occurs_with->${b} SET id = type::record('co_occurs_with', ${key}), strength = 1, last_seen = time::now()`,
          )
          .collect();
      }
    }
  }
}
