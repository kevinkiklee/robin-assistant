/**
 * Poll the SurrealDB server's `/health` endpoint until it responds OK or
 * the deadline elapses.
 *
 * `/health` is unauthenticated in surreal v3, so we don't need credentials
 * just to confirm readiness. A 2xx response means the storage backend is
 * mounted and ready to accept queries.
 *
 * @param {{
 *   bind?: string,
 *   timeoutMs?: number,
 *   intervalMs?: number,
 *   fetchFn?: typeof globalThis.fetch,
 * }} opts
 * @returns {Promise<boolean>} true if ready, false on timeout
 */
export async function surrealEnsureRunning({
  bind = '127.0.0.1:8000',
  timeoutMs = 30000,
  intervalMs = 200,
  fetchFn = globalThis.fetch,
} = {}) {
  const url = `http://${bind}/health`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const resp = await fetchFn(url, { method: 'GET' });
      if (resp.ok) return true;
    } catch {
      // server not listening yet
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}
