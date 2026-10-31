import type { RobinDb } from '../../../brain/memory/db.ts';
import { allMigrations } from '../../../brain/memory/migrations/index.ts';
import type { Invariant } from '../types.ts';

export function dbSchemaCurrentInvariant(db: RobinDb): Invariant {
  return {
    name: 'db.schema_current',
    severity: 'critical',
    symptom: 'Daemon refuses to start with "pending migrations" error.',
    cause: 'Package upgrade introduced new schema migrations that have not been applied.',
    fix: 'Restart the daemon — it applies pending migrations on startup. Run `robin doctor` to verify.',
    check: () => {
      const expected = allMigrations[allMigrations.length - 1]?.version ?? 0;
      const row = db.prepare('SELECT MAX(version) as v FROM _migrations').get() as {
        v: number | null;
      };
      const current = row.v ?? 0;
      if (current >= expected) return { ok: true };
      return {
        ok: false,
        message: `applied=${current}, expected=${expected}`,
        remediation: 'restart the daemon (it applies migrations on startup)',
      };
    },
  };
}
