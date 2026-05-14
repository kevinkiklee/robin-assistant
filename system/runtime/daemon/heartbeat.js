/**
 * Bucket-based heartbeat scheduler.
 *
 * Each bucket has its own interval and its own per-bucket running flag.
 * If a bucket's tick is still running when the interval fires, the next
 * tick is coalesced (skipped, not queued).
 *
 * Bucket shape: { name, intervalMs, tick, gate?, fireImmediately? }
 *   - tick: async function. Throws are caught + logged.
 *   - gate: optional sync/async predicate. Returning falsy skips the tick.
 *     Gate throws are caught + treated as skip.
 *   - fireImmediately: optional boolean (default false). When true, fires
 *     once at start() in addition to the interval cadence.
 *
 * Heartbeat polling is sleep-resilient: setInterval-based ticks fire
 * within `intervalMs` of laptop wake — no missed-tick queue burst.
 *
 * Pure module — no DB access here. Daemon wiring builds the buckets.
 */
export function createScheduler({ buckets } = {}) {
  if (!Array.isArray(buckets) || buckets.length === 0) {
    throw new Error('createScheduler: buckets[] is required');
  }
  const timers = new Map();
  // Map<bucketName, Promise> of in-flight ticks. Replaces the prior boolean
  // running-flag map so `stop()` can `await` the live tick promises and
  // callers can drain in-flight DB writes before closing the DB connection.
  const inFlight = new Map();

  function fire(b) {
    if (inFlight.has(b.name)) return inFlight.get(b.name);
    const promise = (async () => {
      try {
        if (typeof b.gate === 'function') {
          let ok = false;
          try {
            ok = await b.gate();
          } catch (e) {
            console.warn(`[scheduler/${b.name}] gate failed: ${e.message}`);
            return;
          }
          if (!ok) return;
        }
        await b.tick();
      } catch (e) {
        console.warn(`[scheduler/${b.name}] tick failed: ${e.message}`);
      } finally {
        inFlight.delete(b.name);
      }
    })();
    inFlight.set(b.name, promise);
    return promise;
  }

  async function start() {
    await stop();
    for (const b of buckets) {
      const t = setInterval(() => {
        fire(b);
      }, b.intervalMs);
      t.unref?.();
      timers.set(b.name, t);
      if (b.fireImmediately) fire(b);
    }
  }

  // Returns a promise that resolves once timers are cancelled AND every
  // in-flight tick has settled. Callers that subsequently close the DB rely
  // on the awaited form so a tick's writes don't race db.close().
  async function stop() {
    for (const t of timers.values()) clearInterval(t);
    timers.clear();
    if (inFlight.size > 0) {
      await Promise.allSettled([...inFlight.values()]);
    }
  }

  return { start, stop };
}
