import { formatJournal } from '../../format/journal.js';
import { listJournalEntries } from '../../../cognition/memory/chronicle.js';

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
        full: {
          type: 'boolean',
          default: false,
          description: 'Return untrimmed list (default trims to limit).',
        },
      },
    },
    handler: async (args = {}) => {
      const limit = args.limit ?? 50;
      const full = args.full === true;
      const entries = await listJournalEntries(db, {
        since: args.since,
        until: args.until,
        limit,
      });
      const rows = entries.map((e) => ({
        ...e,
        id: String(e.id),
        episode_id: e.episode_id ? String(e.episode_id) : null,
      }));
      const { items, meta } = formatJournal(rows, { limit, full });
      return { entries: items, meta };
    },
  };
}
