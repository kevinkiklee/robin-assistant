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
  const running = new Map();

  async function fire(b) {
    if (running.get(b.name)) return;
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
      running.set(b.name, true);
      await b.tick();
    } catch (e) {
      console.warn(`[scheduler/${b.name}] tick failed: ${e.message}`);
    } finally {
      running.set(b.name, false);
    }
  }

  function start() {
    stop();
    for (const b of buckets) {
      const t = setInterval(() => {
        fire(b);
      }, b.intervalMs);
      t.unref?.();
      timers.set(b.name, t);
      if (b.fireImmediately) fire(b);
    }
  }

  function stop() {
    for (const t of timers.values()) clearInterval(t);
    timers.clear();
  }

  return { start, stop };
}
