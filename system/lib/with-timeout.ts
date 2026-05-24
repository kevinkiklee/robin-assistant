/**
 * Promise.race-based timeout wrapper for long-running async operations.
 *
 * Used to bound LLM calls (biographer chunk extraction, embedder row
 * embedding) so a hung Ollama request cannot wedge the daemon's scheduler
 * loop indefinitely. The HTTP request itself is not cancelled — this only
 * rejects the wrapping promise. Server-side work continues until Ollama
 * returns or its own internal timeout fires.
 *
 * This protects against the Bug E class of failure observed on 2026-05-21:
 * biographer hung on qwen3:14b inside `LLMDispatcher.invoke`, never returned,
 * and `Scheduler.tickOnce`'s `await handler(job)` blocked the runLoop. Adding
 * a timeout means the handler throws, `completeJob` writes `errored`, the loop
 * frees up, and the cron re-arm (Bug C fix) tries again next tick.
 */
export class TimeoutError extends Error {
  constructor(
    public readonly opName: string,
    public readonly ms: number,
  ) {
    super(`${opName} timed out after ${ms}ms`);
    this.name = 'TimeoutError';
  }
}

export function withTimeout<T>(promise: Promise<T>, ms: number, opName: string): Promise<T> {
  if (!Number.isFinite(ms) || ms <= 0) {
    throw new RangeError(`withTimeout: ms must be a positive finite number, got ${ms}`);
  }
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError(opName, ms)), ms);
    if (typeof timer.unref === 'function') timer.unref();
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
