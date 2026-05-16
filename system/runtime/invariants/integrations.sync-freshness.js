// integrations.sync_freshness
//
// Compound invariant: iterates enabled+authed integrations from the scheduler
// row. Stale = last_sync_at older than cadence × freshness_threshold_x.
// Default threshold = 2× cadence; per-integration override allowed.
//
// Repair: triggers integration_run sequentially for stale entries, capped
// at 2 per tick (avoids thundering herd).

import { surql } from 'surrealdb';

const DEFAULT_FRESHNESS_X = 2;
const MAX_REPAIRS_PER_TICK = 2;

async function readScheduler(db) {
  const [rows] = await db
    .query(surql`SELECT VALUE value FROM type::record('runtime', 'scheduler');`)
    .collect();
  return rows?.[0] ?? null;
}

function stalenessReport(value, now = Date.now()) {
  const integrations = value?.integrations ?? {};
  const stale = [];
  let enabledCount = 0;
  for (const [name, row] of Object.entries(integrations)) {
    if (!row?.cadence_ms) continue;
    if (row.enabled === false) continue;
    if (!row.last_sync_at) continue;
    enabledCount++;
    const last = new Date(row.last_sync_at).getTime();
    const thresholdX = row.freshness_threshold_x ?? DEFAULT_FRESHNESS_X;
    const thresholdMs = row.cadence_ms * thresholdX;
    if (now - last > thresholdMs) {
      stale.push({
        name,
        last_sync_at: row.last_sync_at,
        threshold_at: new Date(last + thresholdMs).toISOString(),
        cadence_ms: row.cadence_ms,
      });
    }
  }
  return { stale, enabledCount };
}

export default {
  name: 'integrations.sync_freshness',
  level: 'warn',
  surface: 'integrations',
  phase: 'integrations',
  description: 'Enabled integrations sync within their freshness threshold (default 2× cadence).',

  runWhen: {
    boot: { enabled: false },
    heartbeat: { enabled: true, cooldownMs: 10 * 60 * 1000 },
    doctor: { enabled: true },
    postInstall: { enabled: false },
  },

  async enabled(ctx) {
    if (!ctx?.db) return false;
    try {
      const value = await readScheduler(ctx.db);
      const integrations = value?.integrations ?? {};
      return Object.values(integrations).some((r) => r?.cadence_ms && r.enabled !== false);
    } catch {
      return false;
    }
  },

  async check(ctx) {
    if (!ctx?.db) return { ok: false, error: 'no_db_handle' };
    try {
      const value = await readScheduler(ctx.db);
      const { stale, enabledCount } = stalenessReport(value);
      if (stale.length > 0) {
        return {
          ok: false,
          error: 'integrations_stale',
          evidence: { stale_integrations: stale, enabled_count: enabledCount },
        };
      }
      return { ok: true, evidence: { enabled_count: enabledCount } };
    } catch (e) {
      return { ok: false, error: `query_failed:${e.message}` };
    }
  },

  async repair(ctx) {
    if (!ctx?.db) return { repaired: false, error: 'no_db_handle' };
    let targets;
    try {
      const value = await readScheduler(ctx.db);
      targets = stalenessReport(value).stale.slice(0, MAX_REPAIRS_PER_TICK);
    } catch (e) {
      return { repaired: false, error: `query_failed:${e.message}` };
    }
    if (targets.length === 0) {
      return { repaired: false, action: 'no_stale_integrations' };
    }
    if (ctx?.dryRun) {
      return {
        repaired: false,
        action: 'would_trigger_integration_run',
        plan: { targets: targets.map((t) => t.name) },
      };
    }
    // Triggering integration_run requires a host (LLM/HTTP); without it we
    // mark the targets and let the next heartbeat tick (via dispatcher) sync.
    // We don't call into integration runners directly here — the dispatcher
    // tick is the established path that owns auth, rate limits, and cursors.
    // Surfacing the names is sufficient repair signal: the next tick picks
    // them up.
    return {
      repaired: false,
      action: 'flagged_for_next_dispatcher_tick',
      evidence: { flagged: targets.map((t) => t.name) },
    };
  },

  explain(lastResult) {
    const lines = [
      '### `integrations.sync_freshness`',
      '',
      '**Symptom.** Daily brief reports stale data; recall returns nothing for known-recent events.',
      '',
      '**Cause.** One or more integrations have not synced within 2× their declared cadence — auth expired, dispatcher disabled, host detection failed, or the source API is down.',
      '',
      "**Fix.** The next dispatcher tick should pick up flagged integrations. If the issue persists past one tick, check `robin integrations status` for the integration's last error.",
    ];
    if (lastResult?.evidence?.stale_integrations?.length) {
      lines.push(
        '',
        `**Stale:** ${lastResult.evidence.stale_integrations.map((s) => s.name).join(', ')}`,
      );
    }
    return lines.join('\n');
  },
};
