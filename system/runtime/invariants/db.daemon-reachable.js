// db.daemon_reachable
//
// Verifies a raw WebSocket connect to surreal succeeds. Uses dbFactory so
// the invariant works even when ctx.db is null (e.g. reauth in progress).
//
// No automatic repair — a down surreal process is user-actionable
// (launchctl kickstart / surreal start / investigate logs).

import { connect, defaultDbUrl } from '../../data/db/client.js';

async function tryConnect({ timeoutMs = 1000 } = {}) {
  const dbUrl = await defaultDbUrl();
  let db;
  const start = Date.now();
  try {
    db = await Promise.race([
      connect({ engine: dbUrl }),
      new Promise((_, reject) => {
        const t = setTimeout(() => reject(new Error('connect_timeout')), timeoutMs);
        t.unref?.();
      }),
    ]);
    return { ok: true, evidence: { url: dbUrl, elapsedMs: Date.now() - start } };
  } catch (e) {
    return { ok: false, error: e.message ?? 'connect_failed', evidence: { url: dbUrl } };
  } finally {
    if (db) await db.close?.().catch(() => {});
  }
}

export default {
  name: 'db.daemon_reachable',
  level: 'critical',
  surface: 'db',
  phase: 'db',
  description: 'SurrealDB connection succeeds (raw WebSocket open).',

  runWhen: {
    boot: { enabled: true },
    heartbeat: { enabled: true, cooldownMs: 60_000 },
    doctor: { enabled: true },
    postInstall: { enabled: true },
  },

  async check(ctx) {
    // Prefer dbFactory if provided (test injection); otherwise use defaults.
    if (typeof ctx?.dbFactory === 'function') {
      try {
        const db = await ctx.dbFactory();
        if (db?.close) await db.close().catch(() => {});
        return { ok: true, evidence: { via: 'dbFactory' } };
      } catch (e) {
        return { ok: false, error: e.message ?? 'dbFactory_failed' };
      }
    }
    return tryConnect();
  },

  explain() {
    return [
      '### `db.daemon_reachable`',
      '',
      '**Symptom.** Daemon logs `connect refused` / `ECONNREFUSED`; every recall/remember call fails; biographer queue stalls.',
      '',
      '**Cause.** The SurrealDB process (`surreal start`) is not running, or the loopback port has shifted.',
      '',
      '**Fix.** No auto-repair. Investigate: `launchctl list io.robin-assistant.surreal`, `ps aux | grep surreal`, the surreal log under `<user-data>/data/snapshots/`. This is correctly user-actionable — Robin should not be silently restarting another process\'s daemon.',
    ].join('\n');
  },
};
