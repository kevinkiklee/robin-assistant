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
      let embedUsage = null;
      try {
        pending = await countPendingEvents(db);
        const [bRows] = await db
          .query(surql`SELECT * FROM type::record('runtime', 'biographer') LIMIT 1`)
          .collect();
        failed = bRows[0]?.value?.failed_event_ids?.length ?? 0;
        // Embed usage (paid profiles only — gemini writes the row in
        // system/data/embed/gemini.js; local profiles leave it absent).
        const [uRows] = await db
          .query(surql`SELECT VALUE value FROM type::record('runtime', 'embed_usage')`)
          .collect();
        const u = uRows?.[0];
        if (u && Number.isFinite(u.total_tokens)) {
          // gemini-embedding-001 interactive pricing: $0.15 / 1M input tokens.
          // Six-decimal precision so sub-cent micro-embeds register
          // (≈6.7 tokens per displayable unit).
          const cost = (u.total_tokens / 1_000_000) * 0.15;
          embedUsage = {
            profile: u.profile ?? null,
            tokens: u.total_tokens,
            requests: u.total_requests ?? 0,
            cost_usd: Math.round(cost * 1_000_000) / 1_000_000,
            since: u.since ?? null,
            last_updated_at: u.last_updated_at ?? null,
          };
        }
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
        embed_usage: embedUsage,
      };
    },
  };
}
