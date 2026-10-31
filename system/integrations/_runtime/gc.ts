import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RobinDb } from '../../brain/memory/db.ts';

// Pure, dependency-light GC helpers for integration bookkeeping. Kept free of any
// kernel imports (only node:* + a TYPE import) so both the integrations scheduler
// glue AND a kernel/invariants health check can use them without an import cycle
// (kernel → integrations → kernel). See `state.no_orphans` invariant + scheduler-glue.

/**
 * `integration_state` is a general KV store, not integration-exclusive: cognition
 * subsystems and user JOBS namespace their cursors/heartbeats by name there too,
 * and those names have NO on-disk `integration.yaml` dir. Without this exemption
 * the orphan GC (which keys on integration dirs alone) treats them as removed
 * integrations and DELETES their live cursors on every daemon boot — resetting the
 * behavior synthesizer / recommendation-scan cursors (forcing full reprocessing)
 * and wiping a user job's listing baseline (a spurious "everything is new"
 * restock-alert flood). These are the fixed cognition namespaces; on-disk job
 * names are passed in as `extraLive` by callers so new jobs never regress.
 */
export const RESERVED_STATE_NAMESPACES: ReadonlySet<string> = new Set([
  'behavior', // system/brain/cognition/behavior — habit inference cursor
  'recommendations', // system/brain/cognition/recommendations — scan/link cursors
]);

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
  extraLive?: ReadonlySet<string>,
): number {
  if (onDiskNames.size === 0) return 0; // can't trust the on-disk set → never delete
  const names = removedStateNames(db, onDiskNames, extraLive);
  const del = db.prepare('DELETE FROM integration_state WHERE integration_name = ?');
  let removed = 0;
  for (const name of names) {
    removed += del.run(name).changes;
    log?.warn({ integration: name }, 'GC state for removed integration (no directory on disk)');
  }
  return removed;
}

/**
 * Prune terminal job rows (`completed` | `errored`) older than `retentionDays`.
 * Every cron tick leaves a permanent terminal row behind (`completeJob` never
 * deletes; cron re-enqueues a fresh row each occurrence), so the jobs table grows
 * unboundedly — 20k+ completed rows accrued, and stale `errored` rows (e.g. linear's
 * pre-fix GraphQL 400) lingered for days, reading as "currently broken". Nothing
 * reads terminal history beyond 24h (integration status scopes errors to 24h;
 * `scheduler-progressing` uses MAX(created_at); the `list` tool wants most-recent-N),
 * so a multi-day retention is safe with wide margin. Non-terminal rows
 * (pending/leased) are never touched. Returns the number of rows deleted.
 */
export function gcStaleTerminalJobs(
  db: RobinDb,
  retentionDays: number,
  log?: { warn: (obj: unknown, msg?: string) => void },
): number {
  const result = db
    .prepare(
      `DELETE FROM jobs
        WHERE state IN ('completed','errored')
          AND created_at < datetime('now', ?)`,
    )
    .run(`-${retentionDays} days`);
  if (result.changes > 0) {
    log?.warn({ deleted: result.changes, retentionDays }, 'GC stale terminal job rows');
  }
  return result.changes;
}

/**
 * Prune claude_code `session:*` KV rows older than `retentionDays`. The capture
 * scanner writes one row per Claude Code session FILE ever seen (mtime dedup),
 * re-stamping `updated_at` each time it re-checks the file — so a row untouched
 * for `retentionDays` means that transcript hasn't changed in that long and will
 * not be re-parsed (a re-parse is harmless anyway: dedup_hit catches it). 126k
 * rows accrued unbounded before this. `updated_at` is space-format (KvStore
 * writes datetime('now')), matching the datetime('now', ?) cutoff — no T-vs-space
 * trap. Scoped to `session:%` so heartbeat/token rows survive. Returns rows deleted.
 */
export function gcStaleSessionState(
  db: RobinDb,
  retentionDays: number,
  log?: { warn: (obj: unknown, msg?: string) => void },
): number {
  const result = db
    .prepare(
      `DELETE FROM integration_state
        WHERE integration_name = 'claude_code' AND key LIKE 'session:%'
          AND updated_at < datetime('now', ?)`,
    )
    .run(`-${retentionDays} days`);
  if (result.changes > 0) {
    log?.warn(
      { deleted: result.changes, retentionDays },
      'GC stale claude_code session-state rows',
    );
  }
  return result.changes;
}

/** Read-only: count of claude_code `session:*` KV (mtime-dedup) rows. */
export function countSessionState(db: RobinDb): number {
  const row = db
    .prepare(
      "SELECT COUNT(*) AS n FROM integration_state WHERE integration_name = 'claude_code' AND key LIKE 'session:%'",
    )
    .get() as { n: number };
  return row.n;
}

/** Read-only: count of terminal (`completed` | `errored`) job rows. */
export function countTerminalJobs(db: RobinDb): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM jobs WHERE state IN ('completed','errored')")
    .get() as { n: number };
  return row.n;
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

/**
 * Read-only: integration_state names owned by nothing live. Empty on-disk set → [].
 * A name is "live" if it has an integration dir on disk (`onDiskNames`), is a
 * reserved cognition namespace (`RESERVED_STATE_NAMESPACES`), or is a currently
 * on-disk job passed in via `extraLive` — only genuinely removed owners are returned.
 */
export function removedStateNames(
  db: RobinDb,
  onDiskNames: Set<string>,
  extraLive?: ReadonlySet<string>,
): string[] {
  if (onDiskNames.size === 0) return [];
  const rows = db
    .prepare('SELECT DISTINCT integration_name AS name FROM integration_state')
    .all() as Array<{ name: string }>;
  return rows
    .map((r) => r.name)
    .filter(
      (n) =>
        !onDiskNames.has(n) && !RESERVED_STATE_NAMESPACES.has(n) && !(extraLive?.has(n) ?? false),
    );
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
  extraLive?: ReadonlySet<string>,
): { orphanTickCrons: string[]; orphanStateNames: string[] } {
  return {
    orphanTickCrons: orphanTickCronNames(db, liveTickNames),
    orphanStateNames: removedStateNames(db, onDiskNames, extraLive),
  };
}
