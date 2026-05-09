import { listPatterns } from '../../memory/patterns.js';

export function createListPatternsTool({ db }) {
  return {
    name: 'list_patterns',
    description: 'List recurring observation patterns dream has identified.',
    inputSchema: {
      type: 'object',
      properties: {
        active_only: { type: 'boolean', default: false },
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
      },
    },
    handler: async (args = {}) => {
      const list = await listPatterns(db, {
        activeOnly: args.active_only ?? false,
        limit: args.limit ?? 50,
      });
      return { patterns: list.map((p) => ({ ...p, id: String(p.id) })) };
    },
  };
}
