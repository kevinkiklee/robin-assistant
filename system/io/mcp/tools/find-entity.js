import { surql } from 'surrealdb';
import { stage1Resolve } from '../../../cognition/biographer/stage1-exact.js';
import { stage2Resolve } from '../../../cognition/biographer/stage2-embedding.js';
import { wrapEntityRecord } from '../../../cognition/discretion/wrap-untrusted.js';
import { toRecordRef } from '../../../data/db/record-ref.js';
import { markTainted } from '../../../runtime/mcp/session-taint.js';
import { formatEntity } from '../../format/entity.js';

export function createFindEntityTool({ db, embedder, getSessionId }) {
  return {
    name: 'find_entity',
    description:
      'Find entities (people, places, projects, topics, things) by name. Returns ranked matches.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', minLength: 1, maxLength: 200 },
        type: { type: 'string', enum: ['person', 'place', 'project', 'topic', 'thing'] },
        fuzzy: { type: 'boolean', default: true },
        limit: { type: 'integer', minimum: 1, maximum: 50, default: 5 },
        full: {
          type: 'boolean',
          default: false,
          description:
            'Return untrimmed edges + events per match (default trims). Most matches have neither field populated here, so this is reserved for forward compatibility.',
        },
      },
      required: ['name'],
    },
    handler: async (args) => {
      const sessionId = getSessionId?.() ?? null;
      const full = args.full === true;
      const shape = (rows) =>
        rows.map((r) => {
          const formatted = formatEntity(
            {
              id: r.id,
              kind: r.type,
              name: r.name,
              summary: r.summary ?? null,
              edges: r.edges ?? [],
              events: r.events ?? [],
              created_at: r.created_at,
              similarity: r.similarity,
            },
            { full },
          );
          const trust = r.derived_from_trust ?? 'trusted';
          if (trust !== 'trusted') markTainted(sessionId, r.id);
          if (trust === 'trusted') return formatted;
          // Wrap the serialized entity so the agent sees untrusted entity names/summaries
          // inside a nonce-suffixed isolation block.
          return wrapEntityRecord(formatted, { trust });
        });
      const limit = args.limit ?? 5;
      const fuzzy = args.fuzzy !== false;
      if (!fuzzy) {
        const types = args.type ? [args.type] : ['person', 'place', 'project', 'topic', 'thing'];
        const matches = [];
        for (const t of types) {
          const id = await stage1Resolve(db, { name: args.name, type: t });
          if (id) {
            const [rows] = await db
              .query(
                surql`SELECT id, name, type, created_at, derived_from_trust FROM ${toRecordRef(id)}`,
              )
              .collect();
            if (rows[0]) matches.push({ ...rows[0], id: String(rows[0].id) });
          }
        }
        return { entities: shape(matches.slice(0, limit)) };
      }
      const types = args.type ? [args.type] : ['person', 'place', 'project', 'topic', 'thing'];
      const all = [];
      for (const t of types) {
        const r = await stage2Resolve(db, embedder, {
          name: args.name,
          type: t,
          highThreshold: 0,
          lowThreshold: 0,
        });
        if (r.action === 'resolve') {
          all.push({ id: r.entityId, similarity: r.similarity });
        } else if (r.action === 'escalate') {
          for (const c of r.candidates) all.push({ id: c.id, similarity: c.similarity });
        }
      }
      all.sort((a, b) => b.similarity - a.similarity);
      const ids = all.slice(0, limit).map((c) => c.id);
      if (ids.length === 0) return { entities: [] };
      const [rows] = await db
        .query(
          surql`SELECT id, name, type, created_at, derived_from_trust FROM entities WHERE id IN ${ids}`,
        )
        .collect();
      const byId = new Map(rows.map((r) => [String(r.id), r]));
      const matches = all
        .slice(0, limit)
        .map((c) => {
          const r = byId.get(String(c.id));
          return r
            ? {
                id: String(r.id),
                name: r.name,
                type: r.type,
                created_at: r.created_at,
                similarity: c.similarity,
                derived_from_trust: r.derived_from_trust,
              }
            : null;
        })
        .filter(Boolean);
      return { entities: shape(matches) };
    },
  };
}
