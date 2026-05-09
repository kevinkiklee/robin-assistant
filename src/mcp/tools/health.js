import { surql } from 'surrealdb';

export function createHealthTool({ version, startedAt, db, embedder, biographerQueue, sessions }) {
  return {
    name: 'health',
    description: 'Daemon health check: status, uptime, db/embedder state, queue + session counts.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    handler: async () => {
      let pending = 0;
      let failed = 0;
      try {
        const [pendingRows] = await db
          .query(surql`SELECT count() AS n FROM events WHERE biographed_at IS NONE GROUP ALL`)
          .collect();
        pending = pendingRows[0]?.n ?? 0;
        const [bRows] = await db
          .query(surql`SELECT * FROM type::record('runtime', 'biographer') LIMIT 1`)
          .collect();
        failed = bRows[0]?.value?.failed_event_ids?.length ?? 0;
      } catch {
        // db down or pre-migration; report degraded
      }
      return {
        status: db.isOpen() ? 'ok' : 'degraded',
        version,
        uptime_seconds: Math.floor((Date.now() - startedAt.getTime()) / 1000),
        db_open: db.isOpen(),
        embedder_loaded: embedder.isLoaded(),
        pending_events: pending,
        failed_events: failed,
        active_sessions: sessions.count,
        last_biographer_run_at: biographerQueue.lastRunAt,
      };
    },
  };
}
