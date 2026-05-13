import {
  biographerProcess,
  biographerProcessBatch,
} from '../../../cognition/biographer/pipeline.js';
import { readDaemonState } from '../../../config/daemon-state.js';
import { ensureHome, paths } from '../../../config/data-store.js';
import { close, connect, defaultDbUrl } from '../../../data/db/client.js';
import { acquire } from '../../../data/db/lock.js';
import { createEmbedder } from '../../../data/embed/factory.js';
import { captureFromTranscript } from '../../../io/capture/session-capture.js';
import { isPidAlive } from '../../daemon/lock.js';
import { detectHost } from '../../hosts/detect.js';
import { parseArgs } from '../args.js';

// Match biographer-catchup's delegate-when-alive pattern. The daemon's queue
// worker is single-threaded; the CLI pipeline is not aware of it. Letting
// both walk the same pending events concurrently produced the
// "biographer race detected" + Gemini 429 incident captured in
// beqsvw9rk.output.
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

export async function biographerProcessPending(argv) {
  const args = parseArgs(argv);
  const since = args.flags.since ? new Date(args.flags.since) : null;
  const transcriptPath = args.flags['transcript-path'] ?? null;
  const sessionId = args.flags['session-id'] ?? null;

  await ensureHome();

  // Daemon delegation. The route handles the capture pre-step itself when
  // transcript_path is in the body, so forward all of it.
  const state = await readDaemonState(paths.data.daemonState());
  if (state && isPidAlive(state.pid)) {
    const body = {};
    if (since) body.since = since.toISOString();
    if (transcriptPath) body.transcript_path = transcriptPath;
    if (sessionId) body.session_id = sessionId;
    const result = await delegateToDaemon(state, body);
    if (result) {
      const n = typeof result.enqueued === 'number' ? result.enqueued : 0;
      console.log(`process-pending: ${n} events (delegated to daemon)`);
      return;
    }
    // Fall through to CLI path on delegation failure.
  }

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
