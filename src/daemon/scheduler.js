/**
 * Heartbeat-based scheduler for the dream pipeline.
 *
 * Ticks every `heartbeatMs` (default 60s). Each tick:
 *   1. If `runtime:scheduler.next_dream_run_at` is past-due, run dream and
 *      advance the next scheduled time to the next nightly cron hour.
 *   2. Else, if the system is in event-count overflow, run dream.
 *
 * Heartbeat polling is sleep-resilient: when the laptop wakes, the next tick
 * fires within `heartbeatMs` and catches up missed runs. setTimeout-based
 * scheduling, by contrast, can fire far past its target or never fire at all
 * after a long sleep.
 *
 * In-flight guard prevents concurrent runs while a dream is still executing.
 *
 * Pure module — no DB access here. Inject `runDream`, `isOverflow`,
 * `getCronHour`, `readNextRunAt`, `writeNextRunAt` as deps.
 */
export function createScheduler({
  runDream,
  isOverflow,
  getCronHour,
  readNextRunAt,
  writeNextRunAt,
  heartbeatMs = 60_000,
}) {
  let timer = null;
  let inFlight = false;

  function computeNextNightly(cronHour) {
    const now = new Date();
    const next = new Date(now);
    next.setHours(cronHour, 0, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    return next;
  }

  async function tick() {
    if (inFlight) return;
    const next = await readNextRunAt();
    if (next && new Date() >= new Date(next)) {
      inFlight = true;
      try {
        await runDream({ trigger: 'cron' });
        await writeNextRunAt(computeNextNightly(getCronHour()));
      } finally {
        inFlight = false;
      }
      return;
    }
    if (!inFlight && (await isOverflow())) {
      inFlight = true;
      try {
        await runDream({ trigger: 'overflow' });
      } finally {
        inFlight = false;
      }
    }
  }

  function start() {
    if (timer) clearInterval(timer);
    timer = setInterval(() => {
      tick().catch(() => {});
    }, heartbeatMs);
    timer.unref();
    tick().catch(() => {});
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { start, stop };
}
