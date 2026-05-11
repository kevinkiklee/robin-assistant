/**
 * Heartbeat-based scheduler for integrations + dream pipeline.
 *
 * Ticks every `heartbeatMs` (default 60s). Each tick:
 *   1. `listDue()` returns `[{ name, kind }]` for items whose `next_run_at`
 *      has passed (integrations with kind='integration', dream with
 *      kind='dream' and name='__dream__').
 *   2. For each due item, dispatch via `runOne(name)`. Per-name in-flight
 *      tracking prevents the same integration from running twice but lets
 *      different integrations run concurrently.
 *   3. If nothing else is in flight and `isOverflow()` is true, kick the
 *      dream pipeline via `runOne('__dream__')`.
 *
 * Heartbeat polling is sleep-resilient: when the laptop wakes, the next tick
 * fires within `heartbeatMs` and catches up missed runs. setTimeout-based
 * scheduling, by contrast, can fire far past its target or never fire at all
 * after a long sleep.
 *
 * Pure module — no DB access here. Inject `listDue`, `runOne`, `isOverflow`
 * as deps. Daemon wiring in Task 12 maps these to DB-backed implementations.
 */
export function createScheduler({ listDue, runOne, isOverflow, heartbeatMs = 60_000 }) {
  let timer = null;
  const inFlight = new Set();

  async function tick() {
    const due = (await listDue?.()) ?? [];
    for (const item of due) {
      if (inFlight.has(item.name)) continue;
      inFlight.add(item.name);
      runOne(item.name)
        .catch((e) => console.warn(`[scheduler] ${item.name} failed: ${e.message}`))
        .finally(() => inFlight.delete(item.name));
    }
    if (inFlight.size === 0 && (await isOverflow?.())) {
      inFlight.add('__dream__');
      runOne('__dream__')
        .catch((e) => console.warn(`[scheduler] __dream__ failed: ${e.message}`))
        .finally(() => inFlight.delete('__dream__'));
    }
  }

  function start() {
    if (timer) clearInterval(timer);
    timer = setInterval(() => {
      tick().catch((e) => console.warn(`[scheduler] tick failed: ${e.message}`));
    }, heartbeatMs);
    timer.unref();
    tick().catch((e) => console.warn(`[scheduler] initial tick failed: ${e.message}`));
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { start, stop };
}
