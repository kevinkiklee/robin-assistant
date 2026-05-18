import { BoundQuery } from 'surrealdb';
import { wrapUntrusted } from '../../../../cognition/discretion/wrap-untrusted.js';

function wrapEvent(r) {
  return {
    ...r,
    content: wrapUntrusted(r.content ?? '', {
      source: r.source ?? 'google_calendar',
      eventId: r.id,
      trust: r.trust ?? 'untrusted',
    }),
  };
}

export function createCalendarListEventsTool({ db }) {
  return {
    name: 'calendar_list_events',
    description: 'List captured Google Calendar events from the events table.',
    inputSchema: {
      type: 'object',
      properties: {
        since: { type: 'string', format: 'date-time' },
        until: { type: 'string', format: 'date-time' },
        limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
      },
    },
    handler: async (args) => {
      const filters = ["source = 'google_calendar'"];
      const bindings = {};
      if (args.since) {
        filters.push('ts >= $since');
        bindings.since = new Date(args.since);
      }
      if (args.until) {
        filters.push('ts <= $until');
        bindings.until = new Date(args.until);
      }
      const limit = Math.min(args.limit ?? 50, 200);
      const sql = `SELECT id, content, ts, meta FROM events WHERE ${filters.join(' AND ')} ORDER BY ts ASC LIMIT ${limit}`;
      const [rows] = await db.query(new BoundQuery(sql, bindings)).collect();
      return { events: rows.map((r) => wrapEvent({ ...r, id: String(r.id) })) };
    },
  };
}
