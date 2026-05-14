import { surql } from 'surrealdb';
import {
  biographerProcess,
  biographerProcessBatch,
} from '../../../cognition/biographer/pipeline.js';
import { readDaemonState } from '../../../config/daemon-state.js';
import { ensureHome, paths } from '../../../config/data-store.js';
import { close, connect, defaultDbUrl } from '../../../data/db/client.js';
import { acquire } from '../../../data/db/lock.js';
import { createEmbedder } from '../../../data/embed/factory.js';
import { isPidAlive } from '../../daemon/lock.js';
import { detectHost } from '../../hosts/detect.js';
import { parseArgs } from '../args.js';

// When the daemon is up, its accumulator + single-worker queue are the
// authoritative biographer path. Two pipelines walking the same pending
// queue concurrently is what produced the "biographer race detected" + Gemini
// 429 RESOURCE_EXHAUSTED clusters in beqsvw9rk.output. Mirroring stop-hook's
// delegate-when-alive pattern keeps cron-driven catchup safe.
async function delegateToDaemon(state, body, fetchFn = fetch) {
  try {
    const url = `http://127.0.0.1:${state.port}/internal/biographer/process-pending`;
    const headers = { 'content-type': 'application/json' };
    if (state.auth_token) headers.authorization = `Bearer ${state.auth_token}`;
    const res = await fetchFn(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    return await res.json().catch(() => ({}));
  } catch {
    return null;
  }
}

export async function biographerCatchup(argv) {
  const args = parseArgs(argv);
  const retryFailed = args.flags['retry-failed'] === true;

  await ensureHome();

  // Daemon path first. --retry-failed reads from runtime:biographer.failed_event_ids
  // which the daemon's accumulator/worker doesn't traverse, so we always run the
  // CLI pipeline for that flag.
  if (!retryFailed) {
    const state = await readDaemonState(paths.data.daemonState());
    if (state && isPidAlive(state.pid)) {
      const result = await delegateToDaemon(state, {});
      if (result) {
        const n = typeof result.enqueued === 'number' ? result.enqueued : 0;
        console.log(`processed ${n} events (delegated to daemon)`);
        return;
      }
      // Fall through to CLI path on delegation failure so a flaky daemon
      // doesn't block the cron.
    }
  }

  const release = await acquire(paths.data.daemonLock());
  try {
    const db = await connect({ engine: await defaultDbUrl() });
    try {
      let pending;
      if (retryFailed) {
        const [rt] = await db
          .query(surql`SELECT * FROM type::record('runtime', 'biographer') LIMIT 1`)
          .collect();
        const ids = rt[0]?.value?.failed_event_ids ?? [];
        if (ids.length === 0) {
          console.log('processed 0 events (nothing to retry)');
          return;
        }
        const [rows] = await db
          .query(surql`SELECT id, source FROM events WHERE id IN ${ids}`)
          .collect();
        pending = rows;
      } else {
        const { listPendingEvents } = await import(
          '../../../cognition/biographer/pending-events.js'
        );
        pending = await listPendingEvents(db, { limit: 100 });
      }

      if (pending.length === 0) {
        console.log('processed 0 events');
        return;
      }

      // Lazy: only build embedder + host when we actually have work to do.
      const embedder = await createEmbedder({ db });
      const host = await detectHost();

      // Group by source so each batch shares one episode lookup + entity catalog.
      const bySource = new Map();
      for (const row of pending) {
        const key = row.source ?? '__unknown__';
        if (!bySource.has(key)) bySource.set(key, []);
        bySource.get(key).push(row.id);
      }

      let ok = 0;
      let failed = 0;
      const MAX = 8;
      for (const ids of bySource.values()) {
        for (let i = 0; i < ids.length; i += MAX) {
          const chunk = ids.slice(i, i + MAX);
          try {
            const r = await biographerProcessBatch(db, embedder, host, chunk);
            for (const eid of chunk) {
              const out = r?.perEvent?.get?.(String(eid));
              if (out?.processed) ok++;
              else if (out?.skipped) ok++;
              else failed++;
            }
          } catch (e) {
            // Whole-batch failure — fall back to per-event so individual errors
            // are isolated and reported.
            console.error(
              `batch failed (${chunk.length} events): ${e.message}; falling back to per-event`,
            );
            for (const eid of chunk) {
              try {
                await biographerProcess(db, embedder, host, eid);
                ok++;
              } catch (ee) {
                failed++;
                console.error(`failed: ${eid}: ${ee.message}`);
              }
            }
          }
        }
      }
      console.log(`processed ${ok} events${failed ? ` (${failed} failed)` : ''}`);
    } finally {
      await close(db);
    }
  } finally {
    await release();
  }
}
