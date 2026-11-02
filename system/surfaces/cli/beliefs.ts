import { reconcileConflicts } from '../../brain/cognition/belief-reconcile.ts';
import { runTopicHygiene } from '../../brain/cognition/topic-hygiene.ts';
import { buildDispatcherFromConfig } from '../../brain/llm/build-dispatcher.ts';
import type { LLMDispatcher } from '../../brain/llm/dispatcher.ts';
import {
  countPendingCandidates,
  listBeliefCandidates,
  resolveBeliefCandidate,
} from '../../brain/memory/belief-candidate.ts';
import {
  type CanonicalizeResult,
  canonicalizeBeliefHeads,
} from '../../brain/memory/canonicalize-heads.ts';
import { closeDb, openDb, type RobinDb } from '../../brain/memory/db.ts';
import { allMigrations, applyMigrations } from '../../brain/memory/migrations/index.ts';
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

/**
 * `robin beliefs canonicalize [--apply]` — collapse duplicate belief heads onto
 * canonical topics. Dry-run by default (prints the decision table); `--apply`
 * executes the merge, writing retraction events under non-canonical slugs and an
 * audit event per group decision.
 */
export function runBeliefsCanonicalizeCmd(opts: { apply?: boolean } = {}): void {
  const userData = resolveUserDataDir();
  const db: RobinDb = openDb(dbFilePath(userData));
  applyMigrations(db, allMigrations);
  const llm = buildLlm(userData);
  try {
    const result: CanonicalizeResult = canonicalizeBeliefHeads(db, llm, { apply: opts.apply });
    /* biome-ignore-start lint/suspicious/noConsole: CLI output */
    if (result.decisions.length === 0) {
      console.log('No duplicate belief-head groups found — nothing to canonicalize.');
    } else {
      const mode = opts.apply ? 'Applied' : 'Dry-run';
      console.log(
        `${mode}: ${result.groups} group(s), ${result.merged} merged, ${result.skipped} skipped-dissimilar\n`,
      );
      for (const d of result.decisions) {
        const arrow = d.decision === 'merged' ? '←' : '~ (dissimilar)';
        console.log(`  ${d.canonical} ${arrow} [${d.topics.join(', ')}]`);
      }
      if (!opts.apply && result.merged > 0) {
        console.log(`\nRun with --apply to execute the merge.`);
      }
    }
    /* biome-ignore-end lint/suspicious/noConsole: CLI output */
  } finally {
    closeDb(db);
  }
}

/**
 * `robin beliefs hygiene [--backlog]` — merge belief topics that track the same
 * fact (embedding + lexical nomination, LLM judge; see topic-hygiene.ts). Plain
 * runs one nightly-sized pass. `--backlog` sweeps every head in windows, judging
 * until each window stops yielding — for clearing a large backlog once. Merges
 * are reversible retracted pointer-heads.
 */
export async function runBeliefsHygieneCmd(opts: { backlog?: boolean } = {}): Promise<void> {
  const userData = resolveUserDataDir();
  const db: RobinDb = openDb(dbFilePath(userData));
  applyMigrations(db, allMigrations);
  const llm = buildLlm(userData);
  if (!llm) throw new Error('beliefs hygiene needs an LLM (models.yaml reasoning role)');
  const total = { judged: 0, merged: 0, distinct: 0 };
  const add = (r: Awaited<ReturnType<typeof runTopicHygiene>>) => {
    total.judged += r.pairsJudged;
    total.merged += r.merged;
    total.distinct += r.markedDistinct;
  };
  try {
    /* biome-ignore-start lint/suspicious/noConsole: CLI output */
    if (!opts.backlog) {
      const r = await runTopicHygiene(db, llm);
      add(r);
    } else {
      const WINDOW = 400;
      const heads = topicCount(db);
      for (let offset = 0; offset < heads; offset += WINDOW) {
        for (let round = 0; round < 25; round++) {
          const r = await runTopicHygiene(db, llm, {
            embedProbes: WINDOW,
            probeOffset: offset,
            maxPairs: 30,
            maxMerges: 30,
          });
          add(r);
          if (r.pairsJudged === 0 || r.merged + r.markedDistinct === 0) break;
        }
        console.log(
          `  window ${offset}-${Math.min(offset + WINDOW, heads)}/${heads}: judged ${total.judged}, merged ${total.merged}, distinct ${total.distinct}`,
        );
      }
    }
    console.log(
      `Topic hygiene: judged ${total.judged} pairs — merged ${total.merged}, kept ${total.distinct} as distinct.`,
    );
    /* biome-ignore-end lint/suspicious/noConsole: CLI output */
  } finally {
    closeDb(db);
  }
}

/**
 * `robin beliefs reconcile [--apply] [--include-expired] [--limit=N]` — LLM-judge
 * the conflicted belief-candidate backlog against current heads (same / refines /
 * contradicts / unrelated; see belief-reconcile.ts). Dry-run by default: prints
 * each decision. `--apply` writes them — same → merged, refines → promoted as the
 * new head, contradicts → tagged for the brief. `--include-expired` also re-judges
 * conflicts rejected by stale-conflict expiry in the last 120 days, reopening only
 * the same/refines ones.
 */
export async function runBeliefsReconcileCmd(
  opts: { apply?: boolean; includeExpired?: boolean; limit?: number } = {},
): Promise<void> {
  const userData = resolveUserDataDir();
  const db: RobinDb = openDb(dbFilePath(userData));
  applyMigrations(db, allMigrations);
  const llm = buildLlm(userData);
  if (!llm) throw new Error('beliefs reconcile needs an LLM (models.yaml classify role)');
  try {
    const r = await reconcileConflicts(db, llm, {
      apply: opts.apply,
      includeExpired: opts.includeExpired,
      ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
    });
    /* biome-ignore-start lint/suspicious/noConsole: CLI output */
    const clip = (s: string) => (s.length > 140 ? `${s.slice(0, 140)}…` : s);
    for (const d of r.decisions) {
      console.log(
        `  #${d.id} [${d.topic}] (${d.from}) ${d.verdict ?? '—'} → ${d.outcome}\n      head: ${clip(d.headClaim)}\n      cand: ${clip(d.claim)}`,
      );
    }
    const summary = Object.entries(r.counts)
      .map(([k, v]) => `${k} ${v}`)
      .join(', ');
    console.log(
      `\n${opts.apply ? 'Applied' : 'Dry-run'}: ${r.considered} considered, ${r.judged} judged — ${summary || 'nothing to do'}`,
    );
    if (!opts.apply && r.judged > 0) console.log('Run with --apply to write these decisions.');
    /* biome-ignore-end lint/suspicious/noConsole: CLI output */
  } finally {
    closeDb(db);
  }
}

function topicCount(db: RobinDb): number {
  const row = db
    .prepare(
      `SELECT COUNT(DISTINCT json_extract(payload,'$.topic')) AS n FROM events WHERE kind = 'belief.update'`,
    )
    .get() as { n: number };
  return row.n;
}
