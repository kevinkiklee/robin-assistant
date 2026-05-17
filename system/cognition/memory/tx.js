// tx.js — transaction-conflict retry helper.
//
// SurrealDB's embedded engine surfaces "Transaction conflict: Write conflict"
// when two callers write the same record concurrently. The error is
// retryable: the engine asks us to retry the whole transaction. For
// idempotent writes (UPSERT, gated UPDATE, check-then-RELATE) a small
// bounded retry loop with jittered backoff converges parallel callers to a
// single resolved row.

const DEFAULT_MAX_RETRIES = 4;
export const TX_BASE_BACKOFF_MS = 5;
export const TX_JITTER_MS = 10;

export function isTxConflict(err) {
  return String(err?.message ?? '').includes('Transaction conflict');
}

// Single source of truth for transaction-conflict backoff. Both withTxRetry
// (full-fn retry) and store.js relateAll (per-slice retry) wait this way so
// tuning one knob doesn't drift the other.
export function awaitTxBackoff() {
  return new Promise((r) =>
    setTimeout(r, TX_BASE_BACKOFF_MS + Math.floor(Math.random() * TX_JITTER_MS)),
  );
}

export async function withTxRetry(fn, { maxRetries = DEFAULT_MAX_RETRIES } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (!isTxConflict(e)) throw e;
      lastErr = e;
      await awaitTxBackoff();
    }
  }
  throw lastErr;
}
