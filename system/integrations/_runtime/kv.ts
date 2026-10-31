import type { RobinDb } from '../../brain/memory/db.ts';
import type { KvStore } from './types.ts';

export function createKvStore(db: RobinDb, integrationName: string): KvStore {
  return {
    get(key: string): string | null {
      const row = db
        .prepare(`SELECT value FROM integration_state WHERE integration_name = ? AND key = ?`)
        .get(integrationName, key) as { value: string } | undefined;
      return row?.value ?? null;
    },
    set(key: string, value: string): void {
      db.prepare(`
        INSERT INTO integration_state (integration_name, key, value, updated_at)
        VALUES (?, ?, ?, datetime('now'))
        ON CONFLICT (integration_name, key) DO UPDATE SET value=excluded.value, updated_at=datetime('now')
      `).run(integrationName, key, value);
    },
    delete(key: string): void {
      db.prepare(`DELETE FROM integration_state WHERE integration_name = ? AND key = ?`).run(
        integrationName,
        key,
      );
    },
    // Cross-process single-flight lease. The value column holds the lease's
    // expiry (epoch ms). Acquisition is a single conditional UPSERT: it succeeds
    // only when no row exists (insert) or the existing lease has expired
    // (`value <= nowMs`). SQLite serializes writers, so exactly one connection —
    // e.g. the daemon vs. the MCP process — can win the row at a time. Used to
    // stop concurrent OAuth token refreshes from poisoning a rotating
    // single-use refresh token (WHOOP).
    acquireLock(key: string, ttlMs: number, nowMs: number): boolean {
      const expiry = nowMs + ttlMs;
      const res = db
        .prepare(`
          INSERT INTO integration_state (integration_name, key, value, updated_at)
          VALUES (?, ?, ?, datetime('now'))
          ON CONFLICT (integration_name, key)
          DO UPDATE SET value = excluded.value, updated_at = datetime('now')
          WHERE CAST(integration_state.value AS INTEGER) <= ?
        `)
        .run(integrationName, key, String(expiry), nowMs);
      return res.changes === 1;
    },
    releaseLock(key: string): void {
      db.prepare(`DELETE FROM integration_state WHERE integration_name = ? AND key = ?`).run(
        integrationName,
        key,
      );
    },
  };
}
