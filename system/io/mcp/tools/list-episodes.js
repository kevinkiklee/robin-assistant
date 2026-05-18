import { surql } from 'surrealdb';
import { wrapUntrusted } from '../../../cognition/discretion/wrap-untrusted.js';
import { markTainted } from '../../../runtime/mcp/session-taint.js';
import { formatJournal } from '../../format/journal.js';

export function createListEpisodesTool({ db, getSessionId }) {
  return {
    name: 'list_episodes',
    description: 'List episodes (groupings of related events) with optional time/source filters.',
    inputSchema: {
      type: 'object',
      properties: {
        source: { type: 'string' },
        since: { type: 'string', format: 'date-time' },
        until: { type: 'string', format: 'date-time' },
        active_only: { type: 'boolean', default: false },
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
        full: {
          type: 'boolean',
          default: false,
          description: 'Return untrimmed list (default trims to limit).',
        },
      },
    },
    handler: async (args) => {
      const sessionId = getSessionId?.() ?? null;
      const limit = args.limit ?? 20;
      const full = args.full === true;
      const filters = [];
      const bindings = {};
      if (args.source) {
        filters.push('source = $source');
        bindings.source = args.source;
      }
      if (args.since) {
        filters.push('started_at >= $since');
        bindings.since = new Date(args.since);
      }
      if (args.until) {
        filters.push('started_at <= $until');
        bindings.until = new Date(args.until);
      }
      if (args.active_only) filters.push('ended_at IS NONE');
      const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
      const sql = `SELECT id, started_at, ended_at, source, summary, derived_from_trust FROM episodes ${where} ORDER BY started_at DESC LIMIT ${limit}`;
      const [rows] = await db.query(sql, bindings).collect();
      const episodes = [];
      for (const ep of rows) {
        const [c] = await db
          .query(surql`SELECT count() AS n FROM events WHERE episode_id = ${ep.id} GROUP ALL`)
          .collect();
        const trust = ep.derived_from_trust ?? 'trusted';
        if (trust !== 'trusted') markTainted(sessionId, String(ep.id));
        const rawSummary = ep.summary ?? null;
        const summary =
          trust !== 'trusted' && rawSummary != null
            ? wrapUntrusted(rawSummary, { source: ep.source, eventId: String(ep.id), trust })
            : rawSummary;
        episodes.push({
          id: String(ep.id),
          ts: ep.started_at,
          started_at: ep.started_at,
          ended_at: ep.ended_at ?? null,
          source: ep.source,
          summary,
          event_count: c[0]?.n ?? 0,
        });
      }
      const { items, meta } = formatJournal(episodes, { limit, full });
      return { episodes: items, meta };
    },
  };
}
