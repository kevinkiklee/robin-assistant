import { wrapUntrusted } from '../../../cognition/discretion/wrap-untrusted.js';
import { listKnowledge, searchKnowledge } from '../../../cognition/memory/knowledge.js';
import { formatKnowledge } from '../../format/knowledge.js';

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
        full: {
          type: 'boolean',
          default: false,
          description:
            'Return untrimmed related_entities + recent_events per item (default trims).',
        },
      },
    },
    handler: async (args = {}) => {
      const limit = args.limit ?? 10;
      const full = args.full === true;
      const shape = (rows) =>
        rows.map((k) => {
          const trust = k.derived_from_trust;
          const base = {
            ...k,
            id: String(k.id),
            subject_id: k.subject_id ? String(k.subject_id) : null,
            content:
              trust && trust !== 'trusted'
                ? wrapUntrusted(k.content ?? '', {
                    source: 'knowledge',
                    eventId: String(k.id),
                    trust,
                  })
                : k.content,
          };
          return formatKnowledge(base, { full });
        });
      if (args.query) {
        const hits = await searchKnowledge(db, embedder, args.query, { limit });
        return { knowledge: shape(hits) };
      }
      const list = await listKnowledge(db, { subject_id: args.subject_id, limit });
      return { knowledge: shape(list) };
    },
  };
}
