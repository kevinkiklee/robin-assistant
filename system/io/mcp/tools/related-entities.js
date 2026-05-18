// related_entities — neighbor lookup over the unified edges table.
//
// Phase 2+ (TYPE RELATION) unlocked depth-bounded arrow traversal. With
// `depth: 1` we run the same single-hop SELECT as before. With `depth: 2`
// or `depth: 3` we use SurrealDB's recursive idiom syntax to walk multiple
// hops, returning each reached entity with its discovered hop-distance.

import { formatEntity } from '../../format/entity.js';
import { validateEdgeKinds, validateEntityRef } from './_entity-ref.js';
import { wrapEntityRecord } from '../../../cognition/discretion/wrap-untrusted.js';
import { markTainted } from '../../../runtime/mcp/session-taint.js';

const ENTITY_EDGE_KINDS = ['works_on', 'participates_in', 'occurs_with'];

export function createRelatedEntitiesTool({ db, getSessionId }) {
  return {
    name: 'related_entities',
    description:
      'Find entities connected to a given entity via graph edges (works_on, occurs_with, etc.). Depth 1-3.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        edge_types: { type: 'array', items: { type: 'string', enum: ENTITY_EDGE_KINDS } },
        depth: { type: 'integer', enum: [1, 2, 3], default: 1 },
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
        full: {
          type: 'boolean',
          default: false,
          description: 'Return untrimmed edge/event lists per neighbor entity (default trims).',
        },
      },
      required: ['id'],
    },
    handler: async (args) => {
      const sessionId = getSessionId?.() ?? null;
      const idRef = validateEntityRef(args.id, 'id');
      // Accept the legacy alias `co_occurs_with` from older callers.
      const requested = validateEdgeKinds(
        (args.edge_types ?? ENTITY_EDGE_KINDS).map((k) =>
          k === 'co_occurs_with' ? 'occurs_with' : k,
        ),
        ENTITY_EDGE_KINDS,
      );
      const limit = args.limit ?? 20;
      const depth = args.depth ?? 1;
      const full = args.full === true;

      const raw =
        depth === 1
          ? await depth1(db, idRef, requested, limit)
          : await depthN(db, idRef, requested, depth, limit);
      return {
        related: raw.related.map((r) => {
          const trust = r.entity.derived_from_trust ?? 'trusted';
          if (trust !== 'trusted') markTainted(sessionId, r.entity.id);
          const formatted = formatEntity(
            { id: r.entity.id, kind: r.entity.type, name: r.entity.name },
            { full },
          );
          const entity = trust === 'trusted'
            ? formatted
            : wrapEntityRecord(formatted, { trust });
          return {
            entity,
            // Preserve legacy connector fields:
            ...(r.edge_type ? { edge_type: r.edge_type } : {}),
            ...(r.strength != null ? { strength: r.strength } : {}),
            distance: r.distance,
          };
        }),
      };
    },
  };
}

async function depth1(db, idRef, requested, limit) {
  const related = [];
  for (const kind of requested) {
    if (related.length >= limit) break;
    // `IF in = $self THEN out ELSE in END` collapses direction so symmetric
    // kinds (occurs_with) return the other endpoint regardless of which side
    // this entity sits on after canonical ordering.
    const sql = `SELECT
        IF in = ${idRef} THEN out ELSE in END AS other,
        weight
      FROM edges
      WHERE kind = '${kind}' AND (in = ${idRef} OR out = ${idRef})
      ORDER BY weight DESC
      LIMIT ${limit}`;
    const [rows] = await db.query(sql).collect();
    const others = rows ?? [];
    if (others.length === 0) continue;
    const [entRows] = await db
      .query('SELECT id, name, type, derived_from_trust FROM entities WHERE id IN $ids', {
        ids: others.map((r) => r.other),
      })
      .collect();
    const entById = new Map((entRows ?? []).map((e) => [String(e.id), e]));
    for (const r of others) {
      if (related.length >= limit) break;
      const n = entById.get(String(r.other));
      if (!n) continue;
      related.push({
        entity: { id: String(n.id), name: n.name, type: n.type, derived_from_trust: n.derived_from_trust },
        edge_type: kind,
        ...(r.weight != null ? { strength: r.weight } : {}),
        distance: 1,
      });
    }
  }
  return { related: related.slice(0, limit) };
}

async function depthN(db, idRef, requested, depth, limit) {
  // Multi-hop traversal via SurrealDB v3 recursive idioms. We collect the
  // reachable entity IDs by depth (BFS-like), then hydrate names + types in
  // one SELECT. The mid-edge filter `[WHERE kind IN $kinds]` is applied at
  // every hop, so the depth-2 set is "entities reachable via two requested-kind
  // edges" and so on.
  const seen = new Set([idRef]); // exclude the starting node from results
  const byDistance = []; // [{ id, distance, kind_hint }] in BFS order

  // We walk one hop at a time so we can tag each entity with the smallest
  // distance at which it was discovered. The recursive `{1..N}` form returns
  // all hits without distance tagging, which is less useful for a tool that
  // wants to rank by closeness.
  let frontier = [idRef];
  for (let d = 1; d <= depth; d++) {
    if (frontier.length === 0) break;
    // Frontier values are entity-record string IDs (e.g. "entities:abc").
    // Inlining them as a SurrealQL array literal lets the parser treat each as
    // a record ref, so `in IN $list` compares record-to-record. Passing them
    // as a bound JS string array would compare record-to-string (silent zero).
    const frontierList = frontier.join(', ');
    const kindList = requested.map((k) => `'${k}'`).join(', ');
    const [hits] = await db
      .query(
        `SELECT VALUE (IF in IN [${frontierList}] THEN out ELSE in END)
         FROM edges
         WHERE kind IN [${kindList}]
           AND (in IN [${frontierList}] OR out IN [${frontierList}])`,
      )
      .collect();
    const nextFrontier = [];
    for (const next of hits ?? []) {
      const key = String(next);
      if (seen.has(key)) continue;
      // Edges may reach into events/memos; only keep entities.
      if (!key.startsWith('entities:')) continue;
      seen.add(key);
      byDistance.push({ id: next, distance: d });
      nextFrontier.push(next);
      if (byDistance.length >= limit) break;
    }
    if (byDistance.length >= limit) break;
    frontier = nextFrontier;
  }

  if (byDistance.length === 0) return { related: [] };
  const [entRows] = await db
    .query('SELECT id, name, type, derived_from_trust FROM entities WHERE id IN $ids', {
      ids: byDistance.map((r) => r.id),
    })
    .collect();
  const entById = new Map((entRows ?? []).map((e) => [String(e.id), e]));
  const related = [];
  for (const r of byDistance) {
    const n = entById.get(String(r.id));
    if (!n) continue;
    related.push({
      entity: { id: String(n.id), name: n.name, type: n.type, derived_from_trust: n.derived_from_trust },
      distance: r.distance,
    });
    if (related.length >= limit) break;
  }
  return { related };
}
