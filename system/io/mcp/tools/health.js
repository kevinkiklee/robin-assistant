import { surql } from 'surrealdb';
import { countPendingEvents } from '../../../cognition/biographer/pending-events.js';

export function createHealthTool({ version, startedAt, db, embedder, biographerQueue, sessions }) {
  return {
    name: 'health',
    description: 'Daemon health check: status, uptime, db/embedder state, queue + session counts.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    handler: async () => {
      let pending = 0;
      let failed = 0;
      try {
        pending = await countPendingEvents(db);
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
        biographer_queue_depth: biographerQueue.pendingDepth ?? 0,
        biographer_skipped_since_boot: biographerQueue.skippedSinceBoot ?? 0,
        biographer_last_skipped_at: biographerQueue.lastSkippedAt ?? null,
      };
    },
  };
}
