// get_entity — fetch a single entity with edge summary.
//
// Redesigned for the unified `edges` TYPE RELATION table. The per-relation
// edge tables are gone; counts are computed per-kind by grouping on the
// `edges.kind` field. Optional `path_to` finds the shortest path to a target
// entity through the requested edge kinds (TYPE RELATION arrow traversal).

import { validateEdgeKinds, validateEntityRef } from './_entity-ref.js';

const ENTITY_EDGE_KINDS = ['mentions', 'about', 'works_on', 'participates_in', 'occurs_with'];
const PATH_EDGE_KINDS = ['occurs_with', 'works_on', 'participates_in', 'mentions', 'about'];

export function createGetEntityTool({ db }) {
  return {
    name: 'get_entity',
    description:
      'Fetch a specific entity by its record id, including mention counts and edge summary. Optionally returns shortest path to a target entity.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        path_to: {
          type: 'string',
          description: 'Optional target entity ID. Returns shortest path through edges.',
        },
        path_kinds: {
          type: 'array',
          items: { type: 'string' },
          description:
            "Edge kinds allowed in path. Default: ['occurs_with', 'works_on', 'participates_in'].",
        },
        path_max_depth: { type: 'integer', minimum: 1, maximum: 6, default: 4 },
      },
      required: ['id'],
    },
    handler: async (args) => {
      const idRef = validateEntityRef(args.id, 'id');
      const [rows] = await db
        .query(`SELECT id, name, type, created_at, meta FROM ${idRef}`)
        .collect();
      if (!rows || rows.length === 0) {
        throw new Error(`entity not found: ${args.id}`);
      }
      const entity = rows[0];

      // One grouped query covers all edge kinds. `in = entity OR out = entity`
      // captures both directions; the registry's symmetric kinds canonicalize
      // endpoint order so there are no double-counted rows.
      const [summary] = await db
        .query(
          `SELECT kind, count() AS n FROM edges
           WHERE in = ${idRef} OR out = ${idRef}
           GROUP BY kind`,
        )
        .collect();
      const edgeSummary = Object.fromEntries(ENTITY_EDGE_KINDS.map((k) => [k, 0]));
      for (const row of summary ?? []) {
        edgeSummary[row.kind] = row.n ?? 0;
      }

      const [mentionCount] = await db
        .query(
          `SELECT count() AS n FROM edges
           WHERE kind = 'mentions' AND out = ${idRef} GROUP ALL`,
        )
        .collect();

      // Last mention: most recent inbound mentions edge → source event's ts.
      const [lastMention] = await db
        .query(
          `SELECT in.ts AS ts FROM edges
           WHERE kind = 'mentions' AND out = ${idRef}
           ORDER BY in.ts DESC LIMIT 1`,
        )
        .collect();

      const result = {
        entity: {
          id: String(entity.id),
          name: entity.name,
          type: entity.type,
          created_at: entity.created_at,
          meta: entity.meta ?? null,
          mention_count: mentionCount[0]?.n ?? 0,
          last_mentioned_at: lastMention[0]?.ts ?? null,
          edge_summary: edgeSummary,
        },
      };

      if (args.path_to) {
        const targetRef = validateEntityRef(args.path_to, 'path_to');
        const kinds = validateEdgeKinds(
          args.path_kinds ?? ['occurs_with', 'works_on', 'participates_in'],
          PATH_EDGE_KINDS,
        );
        const maxDepth = Math.min(6, Math.max(1, args.path_max_depth ?? 4));
        result.path = await shortestPath(db, idRef, targetRef, kinds, maxDepth);
      }

      return result;
    },
  };
}

/**
 * BFS-based shortest-path between two entities, walking only the specified
 * edge kinds. Returns null if no path exists within maxDepth.
 *
 * Implementation note: SurrealDB v3 offers `{..+shortest=$target}` for native
 * shortest-path traversal, but it operates on per-table edges (`->wrote->`,
 * etc.). With our generic edges table + mid-edge kind filter, BFS in JS is
 * simpler and stays predictable across kind-set changes.
 */
async function shortestPath(db, sourceRef, targetRef, kinds, maxDepth) {
  if (sourceRef === targetRef) return { found: true, path: [String(sourceRef)], distance: 0 };
  const parent = new Map();
  parent.set(String(sourceRef), null);
  let frontier = [sourceRef];
  for (let d = 1; d <= maxDepth; d++) {
    if (frontier.length === 0) break;
    // Inline record-ref literals (see related-entities.js: bound string arrays
    // don't compare record-to-record correctly with IN).
    const frontierList = frontier.join(', ');
    const kindList = kinds.map((k) => `'${k}'`).join(', ');
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
      if (parent.has(key)) continue;
      // Find any frontier node directly connected to `next` (via an allowed
      // kind) — picking the first satisfies BFS shortest-path.
      const [pHits] = await db
        .query(
          `SELECT VALUE (IF in = ${key} THEN out ELSE in END)
           FROM edges
           WHERE kind IN [${kindList}]
             AND (in = ${key} OR out = ${key})
             AND (in IN [${frontierList}] OR out IN [${frontierList}])
           LIMIT 1`,
        )
        .collect();
      parent.set(key, pHits?.[0] ? String(pHits[0]) : String(frontier[0]));
      nextFrontier.push(next);
      if (key === String(targetRef)) {
        // Reconstruct path from target back to source.
        const path = [];
        let cur = String(targetRef);
        while (cur && parent.has(cur)) {
          path.unshift(cur);
          cur = parent.get(cur);
        }
        return { found: true, path, distance: d };
      }
    }
    frontier = nextFrontier;
  }
  return { found: false, path: null, distance: null };
}
