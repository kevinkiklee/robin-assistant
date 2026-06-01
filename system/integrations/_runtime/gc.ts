import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RobinDb } from '../../brain/memory/db.ts';

// Pure, dependency-light GC helpers for integration bookkeeping. Kept free of any
// kernel imports (only node:* + a TYPE import) so both the integrations scheduler
// glue AND a kernel/invariants health check can use them without an import cycle
// (kernel → integrations → kernel). See `state.no_orphans` invariant + scheduler-glue.

/**
 * Resolve the builtin-integrations root by walking up from THIS module's location,
 * not process.cwd() (under launchd the daemon's cwd is user-data/). This module
 * lives at `<root>/{system|dist}/integrations/_runtime/gc.{ts|js}`; the builtins
 * sit next to it under `../builtin`. Both tsx (system/) and node (dist/) layouts work.
 */
export function resolveBuiltinIntegrationsRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidate = join(here, '..', 'builtin');
  if (existsSync(candidate)) return candidate;
  return join(process.cwd(), 'system/integrations/builtin');
}

/**
 * GC orphaned integration tick crons. When an integration is removed (e.g. the
 * github integration deletion), its `integration.<name>.tick` cron rows survive
 * in the jobs table — and the scheduler RE-ARMS a handler-less job on every tick
 * (runner.ts deliberately keeps it visible), so a removed integration errors
 * forever (github accumulated 158 such rows; embed-backfill 3370). Drop the
 * schedulable rows for any integration tick not in the live set. Scoped to
 * `integration.*.tick` ONLY — for cognition/user jobs a missing handler is a real
 * startup bug we intentionally keep surfacing, so those are left untouched.
 * Returns the number of orphaned rows deleted.
 */
export function gcOrphanIntegrationTicks(
  db: RobinDb,
  liveTickNames: Set<string>,
  log?: { warn: (obj: unknown, msg?: string) => void },
): number {
  const candidates = orphanTickCronNames(db, liveTickNames);
  const del = db.prepare(
    "DELETE FROM jobs WHERE name = ? AND state IN ('pending','scheduled','ready')",
  );
  let removed = 0;
  for (const name of candidates) {
    removed += del.run(name).changes;
    log?.warn({ job: name }, 'GC orphaned integration tick cron (integration no longer loaded)');
  }
  return removed;
}

/**
 * GC the `integration_state` heartbeat/KV rows of integrations whose directory no
 * longer exists on disk. Without this, a removed integration (e.g. github) leaves
 * its last_attempt_at/last_ingest_at/token rows behind forever, so `robin
 * integrations` / the status MCP tool keep listing it as a phantom — last synced
 * days ago, looking broken when it's actually gone. (gcOrphanIntegrationTicks
 * removes the *crons*; this removes the *state* the status report enumerates from.)
 *
 * SAFETY: keyed on `onDiskNames` (directories present), NOT the loaded set — a
 * compile error skips loading but the dir survives, so its tokens are preserved.
 * Two guards prevent a path glitch from nuking live credentials wholesale:
 *   - if `onDiskNames` is empty (roots missing / unreadable), do nothing;
 *   - only names with EXISTING state rows and NO on-disk dir are dropped.
 * Returns the number of (integration, key) rows deleted.
 */
export function gcRemovedIntegrationState(
  db: RobinDb,
  onDiskNames: Set<string>,
  log?: { warn: (obj: unknown, msg?: string) => void },
): number {
  if (onDiskNames.size === 0) return 0; // can't trust the on-disk set → never delete
  const names = removedStateNames(db, onDiskNames);
  const del = db.prepare('DELETE FROM integration_state WHERE integration_name = ?');
  let removed = 0;
  for (const name of names) {
    removed += del.run(name).changes;
    log?.warn({ integration: name }, 'GC state for removed integration (no directory on disk)');
  }
  return removed;
}

/** Read-only: pending/scheduled `integration.*.tick` crons with no live handler. */
export function orphanTickCronNames(db: RobinDb, liveTickNames: Set<string>): string[] {
  const rows = db
    .prepare(
      "SELECT DISTINCT name FROM jobs WHERE name LIKE 'integration.%.tick' AND state IN ('pending','scheduled','ready')",
    )
    .all() as Array<{ name: string }>;
  return rows.map((r) => r.name).filter((n) => !liveTickNames.has(n));
}

/** Read-only: integration_state names with no on-disk dir. Empty on-disk set → []. */
export function removedStateNames(db: RobinDb, onDiskNames: Set<string>): string[] {
  if (onDiskNames.size === 0) return [];
  const rows = db
    .prepare('SELECT DISTINCT integration_name AS name FROM integration_state')
    .all() as Array<{ name: string }>;
  return rows.map((r) => r.name).filter((n) => !onDiskNames.has(n));
}

/**
 * Read-only orphan summary for the health check: how many tick crons + state rows
 * belong to integrations that no longer exist. `liveTickNames` is derived from
 * `onDiskNames` by the caller. With an empty on-disk set, reports zero state
 * orphans (mirrors the GC's guard) so a transient path failure isn't an alarm.
 */
export function findOrphans(
  db: RobinDb,
  liveTickNames: Set<string>,
  onDiskNames: Set<string>,
): { orphanTickCrons: string[]; orphanStateNames: string[] } {
  return {
    orphanTickCrons: orphanTickCronNames(db, liveTickNames),
    orphanStateNames: removedStateNames(db, onDiskNames),
  };
}
