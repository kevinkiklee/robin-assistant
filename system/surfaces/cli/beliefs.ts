import { buildDispatcherFromConfig } from '../../brain/llm/build-dispatcher.ts';
import type { LLMDispatcher } from '../../brain/llm/dispatcher.ts';
import {
  countPendingCandidates,
  listBeliefCandidates,
  resolveBeliefCandidate,
} from '../../brain/memory/belief-candidate.ts';
import { closeDb, openDb, type RobinDb } from '../../brain/memory/db.ts';
import { loadModels } from '../../kernel/config/load.ts';
import { dbFilePath, resolveUserDataDir } from '../../lib/paths.ts';

export interface BeliefsCliOptions {
  /** Filter `review` by candidate status (default: pending). */
  status?: 'pending' | 'promoted' | 'rejected';
  /** Cap rows printed by `review`. */
  limit?: number;
  /** Reason recorded with promote/reject. */
  reason?: string;
}

/** Build a dispatcher the same way the MCP core deps do — lenient, null on failure. */
function buildLlm(userData: string): LLMDispatcher | null {
  try {
    return buildDispatcherFromConfig(loadModels(userData), { lenient: true });
  } catch {
    return null;
  }
}

/** Compact age string from a SQLite `YYYY-MM-DD HH:MM:SS` (UTC) timestamp. */
function ageOf(createdAt: string): string {
  // SQLite stores space-separated UTC; append Z so Date parses it as UTC.
  const then = Date.parse(`${createdAt.replace(' ', 'T')}Z`);
  if (Number.isNaN(then)) return '?';
  const secs = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/**
 * `robin beliefs review` (alias `list`) — print candidate beliefs awaiting review.
 * Honors `--status=` (default pending) and `--limit=`.
 */
export function runBeliefsReview(opts: BeliefsCliOptions = {}): void {
  const userData = resolveUserDataDir();
  const db: RobinDb = openDb(dbFilePath(userData));
  try {
    const status = opts.status ?? 'pending';
    const candidates = listBeliefCandidates(db, {
      status,
      ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
    });
    /* biome-ignore-start lint/suspicious/noConsole: CLI output */
    if (candidates.length === 0) {
      console.log(`No ${status} belief candidates.`);
    } else {
      console.log(`${status} belief candidates (${candidates.length}):`);
      for (const c of candidates) {
        const conf = c.confidence == null ? '—' : c.confidence.toFixed(2);
        console.log(
          `  #${c.id}  [${c.topic}]  conf=${conf}  age=${ageOf(c.createdAt)}\n      ${c.claim}`,
        );
      }
    }
    if (status === 'pending') {
      const pending = countPendingCandidates(db);
      console.log(
        `\n${pending} pending. Promote: robin beliefs promote <id>  Reject: robin beliefs reject <id>`,
      );
    }
    /* biome-ignore-end lint/suspicious/noConsole: CLI output */
  } finally {
    closeDb(db);
  }
}

/** `robin beliefs promote <id> [--reason=...]` — promote a pending candidate into a belief. */
export function runBeliefsPromote(id: number, opts: BeliefsCliOptions = {}): void {
  const userData = resolveUserDataDir();
  const db: RobinDb = openDb(dbFilePath(userData));
  const llm = buildLlm(userData);
  try {
    const r = resolveBeliefCandidate(db, llm, id, 'promote', opts.reason);
    console.log(
      `Promoted candidate #${r.candidateId} → belief event ${r.promotedBeliefEventId ?? '(none)'}.`,
    );
  } finally {
    closeDb(db);
  }
}

/** `robin beliefs reject <id> [--reason=...]` — reject a pending candidate (no truth-stream write). */
export function runBeliefsReject(id: number, opts: BeliefsCliOptions = {}): void {
  const userData = resolveUserDataDir();
  const db: RobinDb = openDb(dbFilePath(userData));
  const llm = buildLlm(userData);
  try {
    const r = resolveBeliefCandidate(db, llm, id, 'reject', opts.reason);
    console.log(`Rejected candidate #${r.candidateId}.`);
  } finally {
    closeDb(db);
  }
}
