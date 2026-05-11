import { surql } from 'surrealdb';
import { stage1Resolve } from '../../graph/stage1-exact.js';
import { stage2Resolve } from '../../graph/stage2-embedding.js';

export function createFindEntityTool({ db, embedder }) {
  return {
    name: 'find_entity',
    description:
      'Find entities (people, places, projects, topics, things) by name. Returns ranked matches.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', minLength: 1 },
        type: { type: 'string', enum: ['person', 'place', 'project', 'topic', 'thing'] },
        fuzzy: { type: 'boolean', default: true },
        limit: { type: 'integer', minimum: 1, maximum: 50, default: 5 },
      },
      required: ['name'],
    },
    handler: async (args) => {
      const limit = args.limit ?? 5;
      const fuzzy = args.fuzzy !== false;
      if (!fuzzy) {
        const types = args.type ? [args.type] : ['person', 'place', 'project', 'topic', 'thing'];
        const matches = [];
        for (const t of types) {
          const id = await stage1Resolve(db, { name: args.name, type: t });
          if (id) {
            const [rows] = await db
              .query(surql`SELECT id, name, type, created_at FROM ${id}`)
              .collect();
            if (rows[0]) matches.push({ ...rows[0], id: String(rows[0].id) });
          }
        }
        return { entities: matches.slice(0, limit) };
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
        .query(surql`SELECT id, name, type, created_at FROM entities WHERE id IN ${ids}`)
        .collect();
      const byId = new Map(rows.map((r) => [String(r.id), r]));
      return {
        entities: all
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
                }
              : null;
          })
          .filter(Boolean),
      };
    },
  };
}
