// Shared plumbing for `robin biographer-catchup` and `robin biographer
// process-pending`. Both commands walk the same pending-event queue; they
// differ only in flag surface (catchup adds --retry-failed; process-pending
// adds --since/--transcript-path/--session-id). Centralizing the daemon
// delegate + the chunked-batch loop keeps their semantics in lockstep.
//
// Why delegate-when-alive: the daemon's accumulator + single-worker queue is
// the authoritative biographer path. Two pipelines walking the same pending
// queue concurrently produced the "biographer race detected" + Gemini 429
// RESOURCE_EXHAUSTED cluster in incident beqsvw9rk.output.

import {
  biographerProcess,
  biographerProcessBatch,
} from '../../../cognition/biographer/pipeline.js';

const DELEGATE_TIMEOUT_MS = 5000;
const BATCH_MAX = 8;

export async function delegateToDaemon(state, body, fetchFn = fetch) {
  try {
    const url = `http://127.0.0.1:${state.port}/internal/biographer/process-pending`;
    const headers = { 'content-type': 'application/json' };
    if (state.auth_token) headers.authorization = `Bearer ${state.auth_token}`;
    const res = await fetchFn(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(DELEGATE_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return await res.json().catch(() => ({}));
  } catch {
    return null;
  }
}

/**
 * Run a list of pending events through biographerProcessBatch, grouped by
 * source so each batch shares one episode lookup + entity catalog. Falls back
 * to per-event processing on batch failure so individual errors are isolated
 * and reported (preserves pre-C1 catchup semantics).
 *
 * @returns {Promise<{ ok: number, failed: number }>}
 */
export async function processPendingChunks(db, embedder, host, pending) {
  const bySource = new Map();
  for (const row of pending) {
    const key = row.source ?? '__unknown__';
    if (!bySource.has(key)) bySource.set(key, []);
    bySource.get(key).push(row.id);
  }

  let ok = 0;
  let failed = 0;
  for (const ids of bySource.values()) {
    for (let i = 0; i < ids.length; i += BATCH_MAX) {
      const chunk = ids.slice(i, i + BATCH_MAX);
      try {
        const r = await biographerProcessBatch(db, embedder, host, chunk);
        for (const eid of chunk) {
          // Mirror the single-event helper in pipeline.js: a missing perEvent
          // entry means the batch deduped or short-circuited that id — treat
          // it as skipped, not as a real failure.
          const out = r?.perEvent?.get?.(String(eid)) ?? { skipped: true };
          if (out.processed || out.skipped) ok++;
          else failed++;
        }
      } catch (e) {
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
  return { ok, failed };
}
