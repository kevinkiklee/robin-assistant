// db.authenticated
//
// Codifies the existing reauth fix in system/data/db/client.js: any DB query
// that hits "Anonymous access not allowed" triggers the reauth single-flight.
// This invariant is the visible surface for that mechanism.

import { isAnonymousError } from '../../data/db/client.js';

// `RETURN 1;` is the canonical SurrealQL probe; doesn't require any table.
const PROBE_SQL = 'RETURN 1;';

export default {
  name: 'db.authenticated',
  level: 'critical',
  surface: 'db',
  phase: 'db',
  description:
    'Shared DB client is authenticated (a probe SELECT succeeds without anonymous-access error).',

  remediation: [
    'reactive retry in `system/data/db/client.js` re-auths on Anonymous errors',
    'if symptom persists: verify SurrealDB credentials in user-data config',
    'restart daemon (kill <pid>) to re-run signin() + use() from boot',
  ],

  runWhen: {
    boot: { enabled: true },
    heartbeat: { enabled: true, cooldownMs: 60_000 },
    doctor: { enabled: true },
    postInstall: { enabled: true },
  },

  async check(ctx) {
    if (!ctx?.db) return { ok: false, error: 'no_db_handle' };
    try {
      const builder = ctx.db.query(PROBE_SQL);
      // The installQueryRetry wrapper in client.js auto-reauths on Anonymous
      // errors; if we reach here, the client is authenticated (possibly via
      // the implicit retry).
      await builder.collect();
      return { ok: true };
    } catch (e) {
      if (isAnonymousError(e)) {
        return { ok: false, error: 'anonymous_access', evidence: { message: e.message } };
      }
      return { ok: false, error: e.message ?? 'probe_failed' };
    }
  },

  // No explicit repair: the installQueryRetry wrapper already calls reauth()
  // single-flight on every Anonymous error. If we still see one here after
  // the wrapper's retry, the credentials are wrong — a manual outcome.

  explain() {
    return [
      '### `db.authenticated`',
      '',
      '**Symptom.** Daemon log fills with `Anonymous access not allowed: Not enough permissions to perform this action`. Scheduler ticks fail; close-stale-episodes fails; etc.',
      '',
      '**Cause.** SurrealDB v2 client reconnects automatically after a WebSocket drop but the reconnected socket comes back anonymous — signin + use must be re-applied.',
      '',
      '**Fix.** Already shipped in `system/data/db/client.js`: a proactive layer subscribes to `connected` to call `reauth()` on reconnects, and a reactive `installQueryRetry` wraps `db.query()` to retry once on Anonymous errors. This invariant codifies the visible surface. If the probe still fails after the reactive retry, the configured credentials are wrong — manual escalation.',
    ].join('\n');
  },
};
