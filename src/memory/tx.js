// tx.js — transaction-conflict retry helper.
//
// SurrealDB's embedded engine surfaces "Transaction conflict: Write conflict"
// when two callers write the same record concurrently. The error is
// retryable: the engine asks us to retry the whole transaction. For
// idempotent writes (UPSERT, gated UPDATE, check-then-RELATE) a small
// bounded retry loop with jittered backoff converges parallel callers to a
// single resolved row.

const DEFAULT_MAX_RETRIES = 4;
const BASE_BACKOFF_MS = 5;
const JITTER_MS = 10;

export function isTxConflict(err) {
  return String(err?.message ?? '').includes('Transaction conflict');
}

export async function withTxRetry(fn, { maxRetries = DEFAULT_MAX_RETRIES } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (!isTxConflict(e)) throw e;
      lastErr = e;
      await new Promise((r) =>
        setTimeout(r, BASE_BACKOFF_MS + Math.floor(Math.random() * JITTER_MS)),
      );
    }
  }
  throw lastErr;
}
