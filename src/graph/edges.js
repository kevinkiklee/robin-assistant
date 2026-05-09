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
