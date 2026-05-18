import { surql } from 'surrealdb';
import { countPendingEvents } from '../../../cognition/biographer/pending-events.js';
import { reshapeForMCP } from '../../format/doctor-health.js';

// Translate a flat (name, surface, ok, warn?, evidence?) probe descriptor
// into a `results[]` entry consumable by `reshapeForMCP`. `warn` is set
// when a probe is up but degraded (e.g., embedder not loaded yet); `ok`
// rolls up to status='ok' and !ok rolls up to 'fail'.
function probe(name, surface, { ok, warn = false, error = null, evidence = null }) {
  const status = ok ? (warn ? 'warn' : 'ok') : 'fail';
  return { name, surface, status, error, evidence };
}

export function createHealthTool({ version, startedAt, db, embedder, biographerQueue, sessions }) {
  return {
    name: 'health',
    description:
      'Daemon health check. Returns realm-grouped (paths/db/integrations/runtime) check ' +
      'status plus runtime metadata (version, uptime, queue depth, embed usage).',
    inputSchema: { type: 'object', properties: {}, required: [] },
    handler: async () => {
      const results = [];
      const ts = new Date().toISOString();

      // db.open — fail-soft if isOpen() throws.
      let dbOpen = false;
      try {
        dbOpen = db.isOpen();
      } catch {
        dbOpen = false;
      }
      results.push(
        probe('db.open', 'db', {
          ok: dbOpen,
          error: dbOpen ? null : 'db handle closed',
        }),
      );

      // Embedder loaded — warn (not fail): a fresh boot before first embed
      // call has `isLoaded=false` and that's normal.
      let embedderLoaded = false;
      try {
        embedderLoaded = embedder.isLoaded();
      } catch {
        embedderLoaded = false;
      }
      results.push(
        probe('embedder.loaded', 'runtime', {
          ok: true,
          warn: !embedderLoaded,
          evidence: { loaded: embedderLoaded },
        }),
      );

      // Biographer queue counts. db-down is reported as a single db probe
      // failure above; queue probes degrade to warn rather than fail to
      // avoid double-fail noise.
      let pending = 0;
      let failed = 0;
      let embedUsage = null;
      let queueOk = true;
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
        queueOk = false;
      }
      results.push(
        probe('biographer.queue', 'runtime', {
          ok: queueOk,
          warn: queueOk && failed > 0,
          error: queueOk ? null : 'queue counts unavailable (db unreachable?)',
          evidence: queueOk ? { pending, failed } : null,
        }),
      );

      // Status rollup mirrors realm logic in reshapeForMCP: any 'fail'
      // wins, else 'warn' if any, else 'ok'.
      const summary = { ok: 0, warn: 0, fail: 0 };
      for (const r of results) summary[r.status] += 1;

      const shape = reshapeForMCP({ results, ts, summary });
      const rollup = summary.fail > 0 ? 'degraded' : dbOpen ? 'ok' : 'degraded';

      return {
        ...shape,
        status: rollup,
        version,
        uptime_seconds: Math.floor((Date.now() - startedAt.getTime()) / 1000),
        db_open: dbOpen,
        embedder_loaded: embedderLoaded,
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
