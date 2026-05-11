import { listKnowledge, searchKnowledge } from '../../../cognition/memory/knowledge.js';

export function createGetKnowledgeTool({ db, embedder }) {
  return {
    name: 'get_knowledge',
    description: 'Search or list knowledge — semantic search via query, or filter by subject_id.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        subject_id: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 50, default: 10 },
      },
    },
    handler: async (args = {}) => {
      const limit = args.limit ?? 10;
      if (args.query) {
        const hits = await searchKnowledge(db, embedder, args.query, { limit });
        return {
          knowledge: hits.map((h) => ({
            ...h,
            id: String(h.id),
            subject_id: h.subject_id ? String(h.subject_id) : null,
          })),
        };
      }
      const list = await listKnowledge(db, { subject_id: args.subject_id, limit });
      return {
        knowledge: list.map((k) => ({
          ...k,
          id: String(k.id),
          subject_id: k.subject_id ? String(k.subject_id) : null,
        })),
      };
    },
  };
}
