import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { RobinDb } from '../../../brain/memory/db.ts';

export interface PreCheckDeps {
  db: RobinDb;
  /** Absolute path to user-data/content/knowledge. */
  knowledgeDir: string;
  now: () => Date;
}

export interface PreCheckResult {
  run: boolean;
  /** Human-readable skip reason, for the tick log. */
  reason?: string;
}

const STALE_NOTE_DAYS = 14;

function count(db: RobinDb, sql: string, ...params: unknown[]): number {
  return (db.prepare(sql).get(...params) as { n: number }).n;
}

/**
 * Deterministic nothing-to-do checks per handler (spec §B4). `run:false` means
 * the tick skips the SDK spawn entirely — zero spend. Checks FAIL OPEN: any
 * error means "run the handler" (a broken pre-check must never silence one).
 * B/G/L have no cheap deterministic emptiness signal and always run.
 */
export function preCheck(handler: string, deps: PreCheckDeps): PreCheckResult {
  try {
    switch (handler) {
      case 'D': {
        // Curation targets stale notes: any knowledge file untouched for 14+ days.
        const cutoff = deps.now().getTime() - STALE_NOTE_DAYS * 86_400_000;
        const entries = readdirSync(deps.knowledgeDir, { recursive: true, withFileTypes: true });
        for (const e of entries) {
          if (e.isFile() && statSync(join(e.parentPath, e.name)).mtimeMs < cutoff) {
            return { run: true };
          }
        }
        return { run: false, reason: 'no knowledge notes older than 14d' };
      }
      case 'E':
        return count(
          deps.db,
          `SELECT COUNT(*) AS n FROM belief_candidates WHERE status='pending'`,
        ) > 0
          ? { run: true }
          : { run: false, reason: 'no pending belief candidates' };
      case 'F':
        return count(
          deps.db,
          `SELECT COUNT(*) AS n FROM predictions
            WHERE outcome IS NULL AND deadline IS NOT NULL AND datetime(deadline) <= datetime(?)`,
          deps.now().toISOString(),
        ) > 0
          ? { run: true }
          : { run: false, reason: 'no predictions past deadline' };
      case 'H':
        return count(
          deps.db,
          `SELECT COUNT(*) AS n FROM events WHERE datetime(ts) >= datetime(?)`,
          new Date(deps.now().getTime() - 48 * 3_600_000).toISOString(),
        ) > 0
          ? { run: true }
          : { run: false, reason: 'no events in the last 48h' };
      case 'K':
        return count(deps.db, `SELECT COUNT(*) AS n FROM alerts WHERE resolved_at IS NULL`) > 0
          ? { run: true }
          : { run: false, reason: 'no open alerts to remediate' };
      default:
        return { run: true }; // B, G, L: no deterministic emptiness signal
    }
  } catch {
    return { run: true };
  }
}
