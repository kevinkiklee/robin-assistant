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
  };
}
