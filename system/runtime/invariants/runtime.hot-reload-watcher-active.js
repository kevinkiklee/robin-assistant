// runtime.hot_reload_watcher_active
//
// Detects: hot-reload watcher (system/runtime/daemon/job-hot-reload.js) was
// not registered at daemon boot, OR was registered and subsequently torn down
// without being restored. Symptom: edits to user-data/jobs/**/*.js stop
// taking effect (ESM cache drift, CLAUDE.md "recurring bugs" entry).
//
// Wiring: job-hot-reload.js writes runtime:hot_reload_watcher at start (active=true)
// and stop (active=false). This invariant reads that row.

export default {
  name: 'runtime.hot_reload_watcher_active',
  level: 'warn',
  surface: 'runtime',
  phase: 'runtime',
  description:
    'Hot-reload watcher is registered and active (else edits to user-data/jobs/* require manual daemon restart).',
  detectOnly: true,
  detectOnlyUntilDays: 7,

  remediation: [
    'kill <daemon-pid>  # launchctl will respawn with a fresh watcher',
    'check: ROBIN_DISABLE_HOT_RELOAD environment variable not set',
    'verify "[hot-reload] watching" lines appear in daemon.log on boot',
  ],

  runWhen: {
    boot: { enabled: true },
    heartbeat: { enabled: true, cooldownMs: 300_000 }, // 5m
    doctor: { enabled: true },
  },

  async check(ctx) {
    if (!ctx?.db) return { ok: false, error: 'no_db_handle' };
    try {
      // Direct record-id access: writers UPSERT `runtime_state:hot_reload_watcher`
      // (see job-hot-reload.js writeWatcherState). `WHERE id = "string"` does
      // not match a RecordId in v2.0.3 — use the bare record literal.
      const builder = ctx.db.query(
        'SELECT active, registered_at FROM runtime_state:hot_reload_watcher;',
      );
      // `.collect()` returns [statementResults, ...]; for one SELECT that's
      // [[row1, row2, ...]]. Destructure once to get the row array, then
      // index for the first record.
      const [results] = await builder.collect();
      const row = results?.[0];
      if (!row) return { ok: false, error: 'watcher_not_registered' };
      if (row.active !== true) {
        return { ok: false, error: 'watcher_inactive', evidence: { row } };
      }
      return { ok: true, evidence: { registered_at: row.registered_at } };
    } catch (e) {
      return { ok: false, error: e.message ?? 'check_failed' };
    }
  },

  explain() {
    return [
      '### `runtime.hot_reload_watcher_active`',
      '',
      '**Symptom.** Edits to `user-data/jobs/**/*.js` (e.g., daily-briefing render logic) do not take effect after save. Cron-fired jobs continue using the old code.',
      '',
      "**Cause.** Node ESM cache pins imported modules for the daemon's lifetime. The hot-reload watcher SIGTERMs the daemon on `.js` changes so launchd respawns with a fresh module graph. If the watcher is not active, edits silently no-op.",
      '',
      '**Fix.** Restart the daemon (kill pid; launchd respawns). If the watcher does not re-register, check `ROBIN_DISABLE_HOT_RELOAD` env var and the daemon boot log for `[hot-reload] watching` lines.',
    ].join('\n');
  },
};
