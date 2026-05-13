import { surql } from 'surrealdb';
import { countPendingEvents } from '../../cognition/biographer/pending-events.js';
import { dreamProcess } from '../../cognition/dream/pipeline.js';
import { runOneJob } from '../../cognition/jobs/runner.js';
import { listDueJobs, planNextRunAt } from '../../cognition/jobs/scheduler-ext.js';
import { embedBackfillTick } from '../../data/embed/backfill.js';
import { activeProfile, embeddingTable } from '../../data/embed/profile-router.js';
import { runIntegrationSync } from '../../io/integrations/_framework/run-sync.js';

/**
 * Build the dispatcherTick function used by the heartbeat 'dispatcher' bucket.
 *
 * The tick body:
 *   1. Refresh jobs from disk so drop-in markdown is picked up.
 *   2. Survey due integrations + dream cursor + embed-backfill + jobs.
 *   3. Fan out via runOneItem with per-name in-flight tracking.
 *   4. Overflow fallback: kick dream when biographer backlog ≥ 500.
 *
 * The tick returns when all due items have been dispatched (concurrently);
 * runs that take longer than the bucket's interval are coalesced by the
 * bucket's per-bucket running flag.
 */
export function createDispatcherTick(ctx, tools) {
  const inFlight = new Set();

  async function runOneItem(name) {
    const job = ctx.jobs.cache.current.find((j) => j.name === name);
    if (job) {
      await runOneJob({
        db: ctx.db,
        capture: ctx.capture.forJobs,
        host: ctx.host,
        embedder: ctx.embedder.wrap,
        jobs: ctx.jobs.cache.current,
        tools,
        name,
      });
      await planNextRunAt(ctx.db, ctx.jobs.cache.current);
      return;
    }
    if (name === '__embed_backfill__') {
      const e = await ctx.embedder.idle.get();
      return await embedBackfillTick({
        db: ctx.db,
        embedder: e,
        batch: 64,
        log: console.log,
      });
    }
    if (name === '__dream__') {
      const e = await ctx.embedder.idle.get();
      try {
        return await dreamProcess(ctx.db, ctx.host, e);
      } finally {
        const next = new Date();
        next.setHours(4, 0, 0, 0);
        if (next <= new Date()) next.setDate(next.getDate() + 1);
        const [drows] = await ctx.db
          .query(surql`SELECT * FROM type::record('runtime', 'scheduler')`)
          .collect();
        const dvalue = drows[0]?.value ?? {};
        const dream = { ...(dvalue.dream ?? {}), next_run_at: next, last_run_at: new Date() };
        await ctx.db
          .query(
            surql`UPSERT type::record('runtime', 'scheduler') SET value = ${{ ...dvalue, dream }}`,
          )
          .collect();
      }
    }
    return await runIntegrationSync(ctx.db, ctx.registry, name);
  }

  return async function dispatcherTick() {
    await ctx.jobs.refresh();
    const due = [];
    const [rows] = await ctx.db
      .query(surql`SELECT * FROM type::record('runtime', 'scheduler')`)
      .collect();
    const value = rows[0]?.value ?? {};
    const integrations = value.integrations ?? {};
    const now = new Date();
    for (const [name, row] of Object.entries(integrations)) {
      if (!row?.next_run_at) continue;
      if (new Date(row.next_run_at) <= now && !row.in_flight) {
        due.push({ name, kind: 'integration' });
      }
    }
    const dreamCursor = value.dream;
    if (dreamCursor?.next_run_at && new Date(dreamCursor.next_run_at) <= now) {
      due.push({ name: '__dream__', kind: 'dream' });
    }
    try {
      const profile = await activeProfile(ctx.db);
      const eventsEmbTbl = embeddingTable(profile, 'events');
      const [pending] = await ctx.db
        .query(
          `SELECT count() AS n FROM events
           WHERE meta.embed_failed IS NOT true
             AND id NOT IN (SELECT VALUE record FROM ${eventsEmbTbl})
           GROUP ALL`,
        )
        .collect();
      if ((pending[0]?.n ?? 0) > 0) {
        due.push({ name: '__embed_backfill__', kind: 'embed_backfill' });
      }
    } catch {
      // No active profile yet (fresh DB) — backfill simply isn't due.
    }
    const jobsDue = await listDueJobs(ctx.db, new Date());
    const all = [...due, ...jobsDue];

    for (const item of all) {
      if (inFlight.has(item.name)) continue;
      inFlight.add(item.name);
      runOneItem(item.name)
        .catch((e) => console.warn(`[scheduler] ${item.name} failed: ${e.message}`))
        .finally(() => inFlight.delete(item.name));
    }
    // Overflow fallback: if nothing else dispatched and biographer backlog ≥ 500, kick dream.
    if (inFlight.size === 0) {
      if ((await countPendingEvents(ctx.db)) >= 500) {
        inFlight.add('__dream__');
        runOneItem('__dream__')
          .catch((e) => console.warn(`[scheduler] __dream__ failed: ${e.message}`))
          .finally(() => inFlight.delete('__dream__'));
      }
    }
  };
}
