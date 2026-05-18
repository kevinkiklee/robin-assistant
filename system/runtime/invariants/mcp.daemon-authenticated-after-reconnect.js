// mcp.daemon_authenticated_after_reconnect
//
// Weekly synthetic disconnect-reconnect cycle to verify the proactive reauth
// handler is still registered. Distinguished from `db.authenticated` which
// covers in-the-moment regressions via the reactive installQueryRetry layer.
// This invariant catches the case where the handler was silently torn down.
//
// Skips during active workload (activeQueryCount > 0) to avoid disturbing
// real traffic. `ctx.activeQueryCount` is OPTIONAL — when absent, treated as
// 0 (always probe). Weekly cadence makes the occasional unnecessary probe
// tolerable until/unless ctx wiring exposes the in-flight counter.

const PROBE_SQL = 'RETURN 1;';

export default {
  name: 'mcp.daemon_authenticated_after_reconnect',
  level: 'warn',
  surface: 'mcp',
  phase: 'mcp',
  description:
    'Weekly probe: synthetic WS disconnect-reconnect followed by SELECT returns without anonymous-access error.',
  detectOnly: true,
  detectOnlyUntilDays: 7,

  remediation: [
    'restart daemon: kill <daemon-pid> (launchctl respawns with fresh wiring)',
    'verify proactive reauth handler is subscribed to client connected event',
    'check db client for `installQueryRetry` wiring',
  ],

  runWhen: {
    boot: { enabled: false }, // too disruptive at boot
    heartbeat: { enabled: true, cooldownMs: 7 * 24 * 3600 * 1000 }, // weekly
    doctor: { enabled: true },
  },

  async check(ctx) {
    if (!ctx?.db) return { ok: false, error: 'no_db_handle' };

    // Skip during active workload to avoid disturbing real traffic.
    if ((ctx.activeQueryCount ?? 0) > 0) {
      return { ok: true, skipped: 'workload_active' };
    }

    // SurrealDB v2.0.3's connect() requires a URL — calling `db.connect()`
    // without one throws inside parseEndpoint(undefined). `db.__url` is
    // stashed by our connect() wrapper in system/data/db/client.js.
    const url = ctx.db.__url;
    if (!url) {
      return {
        ok: false,
        error: 'no_stashed_url',
        evidence: { hint: 'db.__url missing; connect() wrapper regression' },
      };
    }

    try {
      await ctx.db.close();
      await ctx.db.connect(url);
    } catch (e) {
      return {
        ok: false,
        error: 'reconnect_failed',
        evidence: { message: e.message ?? String(e) },
      };
    }

    try {
      const builder = ctx.db.query(PROBE_SQL);
      // `.collect()` returns [statementResults]; unwrap before checking empty.
      const [results] = await builder.collect();
      if (!results || results.length === 0) {
        return { ok: false, error: 'probe_empty' };
      }
      return { ok: true };
    } catch (e) {
      const msg = e.message ?? String(e);
      if (/anonymous/i.test(msg)) {
        return {
          ok: false,
          error: 'anonymous_after_reauth',
          evidence: { message: msg },
        };
      }
      return { ok: false, error: 'probe_failed', evidence: { message: msg } };
    }
  },

  explain() {
    return [
      '### `mcp.daemon_authenticated_after_reconnect`',
      '',
      '**Symptom.** Daemon log fills with `Anonymous access not allowed` after a network blip or laptop sleep. The reactive retry layer (`installQueryRetry`) usually recovers; this invariant catches the case where the proactive reauth handler was silently torn down.',
      '',
      '**Cause.** The `connected` event listener that re-applies `signin()` + `use()` after a WS reconnect was either never registered or was removed. Existing reactive retry catches most cases but adds latency per query.',
      '',
      '**Fix.** Restart the daemon via `kill <pid>` (launchctl respawns it). The proactive handler re-registers at boot. If symptom recurs, audit `system/data/db/client.js` for handler-subscribe logic.',
      '',
      '**Cadence:** weekly heartbeat — chosen to avoid disturbing live workload. Probe is skipped when `activeQueryCount > 0`.',
    ].join('\n');
  },
};
