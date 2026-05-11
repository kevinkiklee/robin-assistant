import { listJournalEntries } from '../../memory/chronicle.js';

export function createListJournalTool({ db }) {
  return {
    name: 'list_journal',
    description: 'Chronological view of significant events.',
    inputSchema: {
      type: 'object',
      properties: {
        since: { type: 'string', format: 'date-time' },
        until: { type: 'string', format: 'date-time' },
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
      },
    },
    handler: async (args = {}) => {
      const entries = await listJournalEntries(db, {
        since: args.since,
        until: args.until,
        limit: args.limit ?? 50,
      });
      return {
        entries: entries.map((e) => ({
          ...e,
          id: String(e.id),
          episode_id: e.episode_id ? String(e.episode_id) : null,
        })),
      };
    },
  };
}
