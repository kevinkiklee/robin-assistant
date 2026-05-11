import { surql } from 'surrealdb';

export function createRunBiographerTool({ db, processor }) {
  return {
    name: 'run_biographer',
    description:
      'Process pending events through the biographer pipeline. Normally automatic; call only when user explicitly asks.',
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['pending', 'failed', 'all'], default: 'pending' },
        limit: { type: 'integer', minimum: 1, maximum: 500, default: 50 },
      },
    },
    handler: async (args) => {
      const scope = args.scope ?? 'pending';
      const limit = args.limit ?? 50;
      let pendingIds = [];
      if (scope === 'failed') {
        const [rt] = await db
          .query(surql`SELECT * FROM type::record('runtime', 'biographer') LIMIT 1`)
          .collect();
        pendingIds = rt[0]?.value?.failed_event_ids ?? [];
      } else if (scope === 'all') {
        const [rows] = await db
          .query(surql`SELECT id, ts FROM events ORDER BY ts ASC LIMIT ${limit}`)
          .collect();
        pendingIds = rows.map((r) => r.id);
      } else {
        const { listPendingEvents } = await import(
          '../../../cognition/biographer/pending-events.js'
        );
        const rows = await listPendingEvents(db, { limit });
        pendingIds = rows.map((r) => r.id);
      }
      let processed = 0;
      let failed = 0;
      const failedIds = [];
      for (const id of pendingIds.slice(0, limit)) {
        try {
          await processor(id);
          processed++;
        } catch {
          failed++;
          failedIds.push(String(id));
        }
      }
      return {
        processed,
        failed,
        ...(failedIds.length ? { failed_event_ids: failedIds } : {}),
      };
    },
  };
}
