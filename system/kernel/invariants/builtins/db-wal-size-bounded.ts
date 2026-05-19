import type { RobinDb } from '../../../brain/memory/db.ts';
import type { Invariant } from '../types.ts';

const WAL_WARN_BYTES = 256 * 1024 * 1024; // 256 MB

export function dbWalSizeBoundedInvariant(db: RobinDb): Invariant {
  return {
    name: 'db.wal_size_bounded',
    severity: 'warning',
    symptom: 'SQLite WAL file grows unboundedly. Reads slow down. Backups take longer.',
    cause:
      'No process is checkpointing the WAL. Either daemon is wedged or the periodic checkpoint job is failing.',
    fix: 'Run `robin db vacuum` to checkpoint. Investigate the periodic checkpoint job in `system/kernel/scheduler/`.',
    check: () => {
      const row = db.prepare('PRAGMA wal_checkpoint(PASSIVE)').get() as {
        busy: number;
        log: number;
        checkpointed: number;
      };
      // log is the number of pages in the WAL. Convert to bytes (page size default 4096).
      const pageSize = (db.prepare('PRAGMA page_size').get() as { page_size: number }).page_size;
      const walBytes = row.log * pageSize;
      if (walBytes < WAL_WARN_BYTES) return { ok: true };
      return {
        ok: false,
        message: `WAL is ${(walBytes / 1024 / 1024).toFixed(1)} MB`,
        remediation: 'robin db vacuum',
      };
    },
    repair: () => {
      db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').run();
    },
  };
}
