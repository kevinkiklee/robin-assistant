import type { RobinDb } from '../../../brain/memory/db.ts';
import { allMigrations } from '../../../brain/memory/migrations/index.ts';
import type { Invariant } from '../types.ts';

export function dbSchemaCurrentInvariant(db: RobinDb): Invariant {
  return {
    name: 'db.schema_current',
    severity: 'critical',
    symptom: 'Daemon refuses to start with "pending migrations" error.',
    cause: 'Package upgrade introduced new schema migrations that have not been applied.',
    fix: 'Run `robin upgrade` to apply pending migrations.',
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
        remediation: 'robin upgrade',
      };
    },
  };
}
