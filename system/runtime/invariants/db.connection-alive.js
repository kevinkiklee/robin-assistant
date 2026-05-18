// db.connection_alive
//
// Probes the daemon's *primary* WS handle (ctx.db) to detect the case where
// the underlying socket has dropped and surrealdb v2.0.3's built-in
// autoreconnect has given up. Distinct from `db.daemon_reachable` which
// opens a *fresh* connection to verify the surreal server is up — the
// daemon's existing handle can be dead even when the server is healthy.
//
// Symptom this catches: the 2026-05-17→18 overnight outage. WS dropped at
// 03:22 UTC, daemon stayed alive emitting 622 ConnectionUnavailableError
// ticks until manual SIGTERM at 11:58 UTC.
//
// Two-line defense:
//   1. `installConnectionRecovery` in system/data/db/client.js wraps every
//      `.collect()`: on ConnectionUnavailableError it calls db.close() +
//      db.connect(url) inline and retries. Most drops recover here without
//      ever touching this invariant.
//   2. THIS invariant probes every 60s. If the probe fails (meaning even
//      the in-process rebuild couldn't recover), repair() SIGTERMs self
//      so launchctl/systemd respawns the daemon with fresh state. Boot is
//      excluded — a SIGTERM during boot would loop.
//
// Policy interaction: level='critical' means decideRepair returns 'auto'
// for the first 2 consecutive_failures and 'manual' (no auto-repair) at 3+.
// In practice the first SIGTERM should respawn the daemon and reset state,
// so we should rarely reach the manual escalation; if we do, health-alert
// surfaces it for human attention.

const PROBE_SQL = 'RETURN 1;';

export default {
  name: 'db.connection_alive',
  level: 'critical',
  surface: 'db',
  phase: 'db',
  description:
    "Daemon's primary DB handle (ctx.db) responds to a probe query — catches the case where the WS socket dropped and surrealdb's autoreconnect gave up.",
  detectOnly: false,
  detectOnlyUntilDays: 0,

  remediation: [
    'in-process recovery via installConnectionRecovery in system/data/db/client.js',
    'after probe failure persists past the recovery layer, repair() SIGTERMs self so launchctl respawns',
    'manual: `kill <daemon-pid>` to force respawn now',
  ],

  runWhen: {
    boot: { enabled: false },
    heartbeat: { enabled: true, cooldownMs: 60_000 },
    doctor: { enabled: true },
    postInstall: { enabled: false },
  },

  async check(ctx) {
    if (!ctx?.db) return { ok: false, error: 'no_db_handle' };
    try {
      const builder = ctx.db.query(PROBE_SQL);
      // The installQueryRetry + installConnectionRecovery wrappers in
      // client.js handle Anonymous + ConnectionUnavailable transparently;
      // if we still see one here, both recovery layers failed.
      await builder.collect();
      return { ok: true };
    } catch (e) {
      const msg = e?.message ?? String(e);
      if (/must be connected to a SurrealDB instance/i.test(msg)) {
        return { ok: false, error: 'connection_unavailable', evidence: { message: msg } };
      }
      return { ok: false, error: 'probe_failed', evidence: { message: msg } };
    }
  },

  async repair(ctx) {
    // By the time we get here, decideRepair() in policy-decisions.js has
    // already gated this call (auto for failures 1-2 at critical level;
    // manual at 3+). The check has installConnectionRecovery as the first
    // line of defense — reaching this repair() means that layer couldn't
    // recover. The right action is to respawn via launchctl/systemd.
    if (ctx?.dryRun) {
      return {
        repaired: false,
        action: 'would_sigterm_self',
        evidence: { pid: process.pid },
      };
    }
    try {
      process.kill(process.pid, 'SIGTERM');
      return { repaired: true, action: 'sigterm_self', evidence: { pid: process.pid } };
    } catch (e) {
      return {
        repaired: false,
        action: 'sigterm_failed',
        evidence: { message: e?.message ?? String(e) },
      };
    }
  },

  explain() {
    return [
      '### `db.connection_alive`',
      '',
      '**Symptom.** Daemon log fills with `ConnectionUnavailableError: You must be connected to a SurrealDB instance` on every scheduler tick. Jobs stop firing; recall/remember fails. Manual daemon restart recovers.',
      '',
      "**Cause.** WebSocket connection to SurrealDB dropped — laptop sleep, network blip, surreal-server restart — and surrealdb v2.0.3's built-in autoreconnect (5 attempts) gave up. The daemon process stays alive but every query throws ConnectionUnavailableError until process restart.",
      '',
      '**Fix.** Primary recovery is `installConnectionRecovery` in `system/data/db/client.js`: catches the error inline, calls `db.close()` + `db.connect(url)`, retries the query once. If that fails (or fails to settle), this invariant escalates: after 3 consecutive heartbeat failures the `repair()` sends SIGTERM to self so launchctl respawns the daemon with a fresh connection.',
    ].join('\n');
  },
};
