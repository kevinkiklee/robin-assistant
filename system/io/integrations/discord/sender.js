// Discord send wrapper with per-chunk retry on 429.
//
// Discord's REST + WS APIs return HTTP 429 with a `Retry-After` header
// (seconds) when a route's rate-limit bucket empties. `sendWithRetry`
// handles up to 3 attempts per chunk with exponential backoff + ±25%
// jitter, honoring `Retry-After` when present.
//
// `sendFn(chunk)` is the actual transport call (discord.js channel.send,
// raw REST POST, whatever). On non-429 errors we re-throw immediately so
// callers see the original failure unmolested.

const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 500;
const JITTER_LOW = 0.75;
const JITTER_HIGH = 1.25;

function is429(err) {
  return err?.code === 429 || err?.status === 429;
}

function retryAfterMs(err) {
  const raw = err?.headers?.['retry-after'] ?? err?.retryAfter;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0;
}

export async function sendWithRetry(chunk, sendFn, opts = {}) {
  const maxAttempts = opts.maxAttempts ?? MAX_ATTEMPTS;
  const baseMs = opts.baseBackoffMs ?? BASE_BACKOFF_MS;
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));

  let attempt = 0;
  let backoffMs = baseMs;
  for (;;) {
    try {
      return await sendFn(chunk);
    } catch (e) {
      if (!is429(e)) throw e;
      attempt += 1;
      if (attempt >= maxAttempts) {
        const err = new Error(`rate_limited after ${attempt} retries`);
        err.reason = 'rate_limited';
        err.attempts = attempt;
        throw err;
      }
      const retryAfter = retryAfterMs(e);
      const jitter = backoffMs * (JITTER_LOW + Math.random() * (JITTER_HIGH - JITTER_LOW));
      const wait = Math.max(retryAfter, jitter);
      await sleep(wait);
      backoffMs *= 2;
    }
  }
}
