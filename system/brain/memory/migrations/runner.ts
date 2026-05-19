import type { RobinDb } from '../db.ts';
import type { Migration } from './types.ts';

const LEDGER_DDL = `
CREATE TABLE IF NOT EXISTS _migrations (
  version    INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);`;

export function applyMigrations(db: RobinDb, migrations: Migration[]): { applied: number[] } {
  db.exec(LEDGER_DDL);

  const applied = db.prepare('SELECT version FROM _migrations ORDER BY version').all() as Array<{
    version: number;
  }>;
  const maxApplied = applied.length > 0 ? applied[applied.length - 1].version : 0;

  const sorted = [...migrations].sort((a, b) => a.version - b.version);
  const pending = sorted.filter((m) => m.version > maxApplied);

  // Non-monotonic guard: any incoming migration with version <= maxApplied but not in applied set is an error
  const appliedSet = new Set(applied.map((a) => a.version));
  for (const m of sorted) {
    if (m.version <= maxApplied && !appliedSet.has(m.version)) {
      throw new Error(
        `Migration ${m.version} (${m.name}) is non-monotonic: applied set is already ahead of it`,
      );
    }
  }

  const newlyApplied: number[] = [];
  const record = db.prepare('INSERT INTO _migrations (version, name) VALUES (?, ?)');

  for (const m of pending) {
    const tx = db.transaction(() => {
      m.up(db);
      record.run(m.version, m.name);
    });
    tx();
    newlyApplied.push(m.version);
  }

  return { applied: newlyApplied };
}
