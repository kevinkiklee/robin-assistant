import { statSync } from 'node:fs';
import type { RobinDb } from '../../../brain/memory/db.ts';
import type { Invariant } from '../types.ts';

const WAL_WARN_BYTES = 256 * 1024 * 1024; // 256 MB

export function dbWalSizeBoundedInvariant(db: RobinDb): Invariant {
  return {
    name: 'db.wal_size_bounded',
    severity: 'warning',
    symptom: 'SQLite WAL file grows unboundedly. Reads slow down. Backups take longer.',
    cause:
      'The WAL is not being checkpointed: a long-lived reader (a stuck MCP server or job) is pinning it, or the daemon is wedged. journal_size_limit only truncates after a checkpoint completes.',
    fix: 'Run `robin db vacuum` to checkpoint. If it regrows, find the process holding a read transaction (`lsof` on the DB file) and restart it.',
    check: () => {
      // Read-only: measure the -wal file size on disk directly. Issuing a
      // `PRAGMA wal_checkpoint` here would attempt a write and throw
      // "attempt to write a readonly database" whenever the check runs over a
      // read-only connection (doctor from a worktree, remote read scope).
      // Checkpointing is a side effect that belongs in repair(), not check().
      let walBytes = 0;
      try {
        walBytes = statSync(`${db.name}-wal`).size;
      } catch {
        // No -wal file (freshly checkpointed, or in-memory db) → 0 bytes.
      }
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
