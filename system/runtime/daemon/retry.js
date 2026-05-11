/**
 * Run `fn` up to `attempts` times. Each attempt is bounded by
 * `perAttemptTimeoutMs`. Between attempts, wait `backoffMs[i]` (last entry
 * may be 0 since the final attempt has no trailing wait).
 *
 * `onRetry(err, attempt)` is called after each failed attempt that will be
 * retried — useful for logging.
 */
export async function retryWithBackoff(fn, { attempts, perAttemptTimeoutMs, backoffMs, onRetry } = {}) {
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new Error('retryWithBackoff: attempts must be >= 1');
  }
  let lastError;
  for (let i = 0; i < attempts; i++) {
    try {
      return await withTimeout(fn, perAttemptTimeoutMs);
    } catch (e) {
      lastError = e;
      const isLast = i === attempts - 1;
      if (!isLast) {
        if (typeof onRetry === 'function') {
          try {
            onRetry(e, i + 1);
          } catch {
            /* swallow */
          }
        }
        const wait = backoffMs?.[i] ?? 0;
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      }
    }
  }
  throw lastError;
}

async function withTimeout(fn, ms) {
  if (!ms || ms <= 0) return await fn();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`retryWithBackoff: timeout after ${ms}ms`)), ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([fn(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
