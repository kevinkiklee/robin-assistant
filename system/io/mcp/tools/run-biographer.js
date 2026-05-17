import { surql } from 'surrealdb';

export function createRunBiographerTool({ db, processor }) {
  return {
    name: 'run_biographer',
    description:
      'Enqueue pending events for the biographer pipeline (fire-and-forget). Returns immediately with the enqueued count; processing happens in the background. Normally automatic; call only when user explicitly asks. Check progress via health().biographer_queue_depth.',
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
      const ids = pendingIds.slice(0, limit);
      let enqueued = 0;
      for (const id of ids) {
        processor(id).catch((e) =>
          console.warn(`[run_biographer] enqueue failed for ${id}: ${e.message}`),
        );
        enqueued++;
      }
      return { enqueued };
    },
  };
}
