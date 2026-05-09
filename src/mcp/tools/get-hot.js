import { getHotContext } from '../../memory/hot.js';

export function createGetHotTool({ db }) {
  return {
    name: 'get_hot',
    description: 'Hot context: active episodes + recent events.',
    inputSchema: {
      type: 'object',
      properties: { source: { type: 'string' } },
    },
    handler: async (args = {}) => {
      const r = await getHotContext(db, { source: args.source });
      return {
        episodes: (r.episodes ?? []).map((e) => ({ ...e, id: String(e.id) })),
        recent_events: (r.recent_events ?? []).map((e) => ({
          ...e,
          id: String(e.id),
          episode_id: e.episode_id ? String(e.episode_id) : null,
        })),
        entities: r.entities ?? [],
      };
    },
  };
}
