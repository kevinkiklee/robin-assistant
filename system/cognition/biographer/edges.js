// edges.js — thin wrappers over `store.relate` used by tests as fixture
// helpers. Production code paths (biographer pipeline, ingest tool) call
// `store.relate` / `store.relateAll` directly; these helpers exist so test
// setups can write a single edge by kind without restating the relate call.

import * as store from '../memory/store.js';

export async function writeMentionsEdge(
  db,
  eventId,
  entityId,
  { weight, context, derived_from_trust } = {},
) {
  return store.relate(db, eventId, entityId, 'mentions', { weight, context, derived_from_trust });
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
