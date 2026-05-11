import { listThreads } from '../../memory/narrative.js';

export function createListThreadsTool({ db }) {
  return {
    name: 'list_threads',
    description: 'List conversation threads (groupings of related episodes).',
    inputSchema: {
      type: 'object',
      properties: {
        since: { type: 'string', format: 'date-time' },
        limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
      },
    },
    handler: async (args = {}) => {
      const list = await listThreads(db, { since: args.since, limit: args.limit ?? 20 });
      return {
        threads: list.map((t) => ({
          ...t,
          id: String(t.id),
          episode_ids: (t.episode_ids ?? []).map(String),
          entity_ids: (t.entity_ids ?? []).map(String),
        })),
      };
    },
  };
}
