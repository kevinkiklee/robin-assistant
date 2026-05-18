// Synthetic embed probe — daily liveness check.
//
// Writes `runtime_state:embed_probe` so the `daemon.embedder_load_age`
// invariant can distinguish "embedder broken" from "no traffic". The
// invariant warns when `last_success_ts` is older than 24h.
//
// Contract:
//   - Calls `embedFn(text)` with a fixed synthetic input.
//   - On success: sets `last_success_ts = now()` and clears `last_error`.
//   - On failure: leaves `last_success_ts` at its previous value (so a
//     single bad day doesn't erase the prior good signal) and writes
//     `last_error = e.message`. The invariant uses `last_success_ts`, so
//     ongoing failures will eventually trip the >24h warning naturally.
//
// State-row writes are intentionally fire-and-forget: swallow DB write
// failures (mirrors `job-hot-reload.js` writeWatcherState) so a transient
// DB hiccup doesn't crash the heartbeat caller.

const PROBE_TEXT = 'robin synthetic embed probe — daily liveness check';

/**
 * Run one probe pass.
 *
 * @param {object} db         SurrealDB handle (must support `.query(...).collect()`).
 * @param {(text: string) => Promise<number[]>} embedFn   Embedder's `embed`.
 * @returns {Promise<{ ok: boolean, error: string | null }>}
 */
export async function writeEmbedProbe(db, embedFn) {
  if (typeof embedFn !== 'function') {
    return { ok: false, error: 'embedFn missing' };
  }

  let priorTs = null;
  try {
    // Direct record-id access: write side UPSERTs `runtime_state:embed_probe`.
    // `WHERE id = "string"` does not match a RecordId in v2.0.3.
    const builder = db.query('SELECT last_success_ts FROM runtime_state:embed_probe;');
    // `.collect()` returns [statementResults, ...]; destructure once.
    const [results] = await builder.collect();
    priorTs = results?.[0]?.last_success_ts ?? null;
  } catch {
    // No prior row, table missing, or DB transient — fall through. The
    // failure-path UPSERT below still creates the row with priorTs=null.
  }

  let ok = false;
  let errorMessage = null;
  try {
    const vec = await embedFn(PROBE_TEXT);
    // Accept both Array and TypedArray: production embedders (gemini, ollama,
    // mxbai) return Float32Array, which Array.isArray() rejects. Duck-type on
    // a numeric .length instead.
    if (!vec || typeof vec.length !== 'number' || vec.length === 0) {
      throw new Error('embedder returned empty vector');
    }
    ok = true;
  } catch (e) {
    errorMessage = e?.message ?? String(e);
  }

  const fields = ok
    ? { last_success_ts: new Date().toISOString(), last_error: null }
    : { last_success_ts: priorTs, last_error: errorMessage };

  try {
    const builder = db.query(
      `UPSERT runtime_state:embed_probe CONTENT {
        last_success_ts: $last_success_ts,
        last_error: $last_error
      };`,
      fields,
    );
    if (builder && typeof builder.collect === 'function') {
      await builder.collect();
    }
  } catch {
    // intentional: state writes must not crash the daemon tick that owns
    // the probe. The invariant will surface the stall on its own.
  }

  return { ok, error: errorMessage };
}
