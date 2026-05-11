import {
  biographerProcess,
  biographerProcessBatch,
} from '../../../cognition/biographer/pipeline.js';
import { ensureHome, paths } from '../../../config/data-store.js';
import { close, connect, defaultDbUrl } from '../../../data/db/client.js';
import { acquire } from '../../../data/db/lock.js';
import { createEmbedder } from '../../../data/embed/factory.js';
import { captureFromTranscript } from '../../../io/capture/session-capture.js';
import { detectHost } from '../../hosts/detect.js';
import { parseArgs } from '../args.js';

export async function biographerProcessPending(argv) {
  const args = parseArgs(argv);
  const since = args.flags.since ? new Date(args.flags.since) : null;
  const transcriptPath = args.flags['transcript-path'] ?? null;
  const sessionId = args.flags['session-id'] ?? null;

  await ensureHome();
  const release = await acquire(paths.data.daemonLock());
  try {
    const db = await connect({ engine: await defaultDbUrl() });
    try {
      let embedder = null;
      let host = null;

      // Capture pre-step. Fail-soft: errors do not block biographer.
      // Hoists embedder + host so the biographer loop below reuses them.
      if (transcriptPath) {
        try {
          embedder = await createEmbedder();
          host = await detectHost();
          await captureFromTranscript(db, embedder, {
            transcriptPath,
            sessionId,
            host: host?.name ?? null,
          });
        } catch (e) {
          console.error(`capture pre-step failed: ${e.message}`);
        }
      }

      // Find pending events (avoids loading embedder when there's nothing to do
      // AND the capture pre-step didn't already load one).
      const { listPendingEvents } = await import('../../../cognition/biographer/pending-events.js');
      const pending = await listPendingEvents(db, { since, limit: 50 });

      if (pending.length === 0) {
        console.log('process-pending: 0 events');
        return;
      }

      if (!embedder) embedder = await createEmbedder();
      if (!host) host = await detectHost();

      // Group by source so each batch shares one episode lookup + entity catalog.
      // Per-source batches preserve C1's semantics (no cross-source mixing).
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
            // are isolated and reported (preserves pre-C1 catchup semantics).
            console.error(
              `batch failed (${chunk.length} events): ${e.message}; falling back to per-event`,
            );
            for (const eid of chunk) {
              try {
                await biographerProcess(db, embedder, host, eid);
                ok++;
              } catch (ee) {
                failed++;
                console.error(`biographer failed on ${eid}: ${ee.message}`);
              }
            }
          }
        }
      }
      console.log(`process-pending: ${ok} events${failed ? ` (${failed} failed)` : ''}`);
    } finally {
      await close(db);
    }
  } finally {
    await release();
  }
}
