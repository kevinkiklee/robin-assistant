import { surql } from 'surrealdb';
import {
  biographerProcess,
  biographerProcessBatch,
} from '../../../cognition/biographer/pipeline.js';
import { ensureHome, paths } from '../../../config/data-store.js';
import { close, connect, defaultDbUrl } from '../../../data/db/client.js';
import { acquire } from '../../../data/db/lock.js';
import { createEmbedder } from '../../../data/embed/factory.js';
import { detectHost } from '../../hosts/detect.js';
import { parseArgs } from '../args.js';

export async function biographerCatchup(argv) {
  const args = parseArgs(argv);
  const retryFailed = args.flags['retry-failed'] === true;

  await ensureHome();
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
      const embedder = await createEmbedder();
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
