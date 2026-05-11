// edges.js — thin wrapper over `store.relate` for legacy call sites.
//
// In the redesigned schema all edges live in a single `edges` table with the
// kind as a discriminator (composite IDs `edges:[kind, from, to]`). The old
// per-relation tables (`mentions`, `about`, `precedes`, `works_on`,
// `participates_in`, `co_occurs_with`) are gone.
//
// New callers should prefer `store.relate` / `store.relateAll` directly. The
// helpers below remain so unit tests and migration paths keep compiling
// during the redesign roll-out. Edge-kind renames:
//   co_occurs_with → occurs_with
//   precedes       → before

import * as store from '../memory/store.js';

export async function writeMentionsEdge(db, eventId, entityId, { weight, context } = {}) {
  return store.relate(db, eventId, entityId, 'mentions', { weight, context });
}

export async function writeAboutEdge(db, eventId, entityId) {
  return store.relate(db, eventId, entityId, 'about');
}

// The old vocabulary used by ingestion / biographer code paths. Map to the
// new registry kinds before delegating to store.relate.
const TYPED_ENTITY_EDGE_KINDS = new Set(['works_on', 'participates_in']);

export async function writeTypedEntityEdge(db, fromId, edgeType, toId) {
  if (!TYPED_ENTITY_EDGE_KINDS.has(edgeType)) {
    throw new Error(`writeTypedEntityEdge: edge type "${edgeType}" not in vocabulary`);
  }
  return store.relate(db, fromId, toId, edgeType);
}

// Symmetric counter edge between every ordered pair drawn from the top
// `cap` entities. `store.relate` canonicalizes endpoint order for symmetric
// kinds and increments `weight` per call (composite-ID UPSERT), so a single
// undirected pass over each unordered pair is enough — no need to emit both
// directions like the old per-table writer did.
export async function writeCoOccursWith(db, entityIds, { cap = 8 } = {}) {
  const top = entityIds.slice(0, cap);
  if (top.length < 2) return;
  const rows = [];
  for (let i = 0; i < top.length; i++) {
    for (let j = i + 1; j < top.length; j++) {
      rows.push({ from: top[i], to: top[j], kind: 'occurs_with' });
    }
  }
  await store.relateAll(db, rows);
}
