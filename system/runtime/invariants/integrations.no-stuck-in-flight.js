// integrations.no_stuck_in_flight
//
// Catches integration syncs that wedge mid-execution during daemon uptime.
// The runner's try/catch clears `in_flight` on both success and failure,
// and a defensive `finally` clears it if the bookkeeping write throws,
// but NOTHING catches the case where `integration.sync(ctx)` returns a
// promise that never resolves (dead loopback fetch, hung WebSocket, awaited
// promise on a closed stream). Without this watchdog, the dispatcher skips
// the wedged integration forever (or until daemon restart triggers boot
// cleanup).
//
// Sibling of scheduler.no_stuck_in_flight, but for the integrations slice
// of the runtime/scheduler record instead of the runtime_jobs table.
//
// Threshold = max(2 × cadence_ms, 30 min). Per-integration cadences vary
// from 15m (gmail) to 1d (chrome, lunch_money). Whoop's 30m cadence with
// a 2× cap would be 1h — tighter than the runtime_jobs 30m floor — which
// is fine; integrations are cheaper to retry than full jobs.
//
// Repair: clears in_flight + in_flight_started_at, leaves a marker in
// last_sync_error, and resets next_run_at to "now" so the dispatcher
// picks it up on the next tick. Heartbeat cooldown = 15 min mirrors the
// scheduler sibling.

import { surql } from 'surrealdb';

const MIN_THRESHOLD_MS = 30 * 60 * 1000;
const CADENCE_MULTIPLIER = 2;
const REPAIR_MARKER = '[watchdog-cleanup: in_flight stuck >threshold]';

async function readScheduler(db) {
  const [rows] = await db
    .query(surql`SELECT VALUE value FROM type::record('runtime', 'scheduler');`)
    .collect();
  return rows?.[0] ?? null;
}

function stuckReport(value, now = Date.now()) {
  const integrations = value?.integrations ?? {};
  const stuck = [];
  for (const [name, row] of Object.entries(integrations)) {
    if (!row?.in_flight) continue;
    if (!row.in_flight_started_at) continue;
    const startedMs = new Date(row.in_flight_started_at).getTime();
    if (!Number.isFinite(startedMs)) continue;
    const cadence = row.cadence_ms ?? 0;
    const threshold = Math.max(cadence * CADENCE_MULTIPLIER, MIN_THRESHOLD_MS);
    const ageMs = now - startedMs;
    if (ageMs > threshold) {
      stuck.push({
        name,
        in_flight_started_at: row.in_flight_started_at,
        age_ms: ageMs,
        threshold_ms: threshold,
        cadence_ms: cadence,
      });
    }
  }
  return stuck;
}

export default {
  name: 'integrations.no_stuck_in_flight',
  level: 'warn',
  surface: 'integrations',
  phase: 'integrations',
  description:
    'No integration syncs have been in_flight=true for more than max(2× cadence, 30 min).',

  remediation: [
    'invariant repair clears `in_flight`, marks the row, and resets `next_run_at` so the next tick picks it up',
    'if symptom recurs: check `user-data/runtime/logs/daemon.log` for hung fetch / WebSocket on the named integration',
    'last resort — restart daemon (`kill <pid>`); boot-cleanup clears all in_flight flags',
  ],

  runWhen: {
    boot: { enabled: false }, // boot-cleanup.js already clears all in_flight at startup
    heartbeat: { enabled: true, cooldownMs: 15 * 60 * 1000 },
    doctor: { enabled: true },
    postInstall: { enabled: false },
  },

  async enabled(ctx) {
    if (!ctx?.db) return false;
    try {
      const value = await readScheduler(ctx.db);
      const integrations = value?.integrations ?? {};
      return Object.keys(integrations).length > 0;
    } catch {
      return false;
    }
  },

  async check(ctx) {
    if (!ctx?.db) return { ok: false, error: 'no_db_handle' };
    try {
      const value = await readScheduler(ctx.db);
      const stuck = stuckReport(value);
      if (stuck.length > 0) {
        return {
          ok: false,
          error: 'stuck_integrations',
          evidence: { names: stuck.map((s) => s.name), count: stuck.length, details: stuck },
        };
      }
      return { ok: true, evidence: { count: 0 } };
    } catch (e) {
      return { ok: false, error: `query_failed:${e.message}` };
    }
  },

  async repair(ctx) {
    if (!ctx?.db) return { repaired: false, error: 'no_db_handle' };
    let value;
    let stuck;
    try {
      value = await readScheduler(ctx.db);
      stuck = stuckReport(value);
    } catch (e) {
      return { repaired: false, error: `query_failed:${e.message}` };
    }
    if (stuck.length === 0) {
      return { repaired: false, action: 'no_stuck_integrations' };
    }
    if (ctx?.dryRun) {
      return {
        repaired: false,
        action: 'would_clear_in_flight',
        plan: { targets: stuck.map((s) => s.name) },
      };
    }
    const integrations = { ...(value?.integrations ?? {}) };
    const cleared = [];
    for (const s of stuck) {
      const row = integrations[s.name];
      if (!row) continue;
      const prior = row.last_sync_error;
      const next_error = !prior
        ? REPAIR_MARKER
        : prior.includes(REPAIR_MARKER)
          ? prior
          : `${prior} ${REPAIR_MARKER}`;
      integrations[s.name] = {
        ...row,
        in_flight: false,
        in_flight_started_at: null,
        last_sync_error: next_error,
        next_run_at: new Date(),
      };
      cleared.push(s.name);
    }
    try {
      await ctx.db
        .query(
          surql`UPDATE type::record('runtime', 'scheduler') SET value.integrations = ${integrations}`,
        )
        .collect();
    } catch (e) {
      return { repaired: false, error: `write_failed:${e.message}` };
    }
    return { repaired: cleared.length > 0, action: 'cleared_in_flight', evidence: { cleared } };
  },

  explain(lastResult) {
    const lines = [
      '### `integrations.no_stuck_in_flight`',
      '',
      '**Symptom.** An integration stops producing fresh data but the daemon is alive. Subsequent dispatcher ticks skip it because `in_flight=true`.',
      '',
      "**Cause.** The integration's `sync()` returned a promise that never resolved (dead loopback fetch, hung WebSocket, awaited promise on a closed stream). Neither the try/catch's success/failure write nor the defensive `finally` ever fired, so `in_flight` stays true until daemon restart.",
      '',
      '**Fix.** Watchdog clears `in_flight`, marks the row, and resets `next_run_at` to "now" so the next dispatcher tick picks it up. Run `pnpm test:file system/tests/unit/integrations-no-stuck-in-flight.test.js` to verify the detection logic if behavior looks off.',
    ];
    if (lastResult?.evidence?.names?.length) {
      lines.push('', `**Stuck integrations:** ${lastResult.evidence.names.join(', ')}`);
    }
    return lines.join('\n');
  },
};
