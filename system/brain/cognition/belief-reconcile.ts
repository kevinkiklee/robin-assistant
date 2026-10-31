import { z } from 'zod';
import { clockDate } from '../../lib/clock.ts';
import type { LLMDispatcher } from '../llm/dispatcher.ts';
import { resolveBeliefCandidate } from '../memory/belief-candidate.ts';
import type { RobinDb } from '../memory/db.ts';
import { DEFAULT_TUNING, getTuning } from '../memory/tuning.ts';
import { getPrompt } from './prompts.ts';

/**
 * Candidate-vs-head adjudication. A candidate on a topic that already has a head
 * used to be either folded into it (token-subset rephrasing) or parked as
 * `conflicted` — and nothing ever looked at the conflicted queue again, so after
 * 30 days it expired. Most of those "conflicts" were refinements ("favorite tea is
 * green tea, since spring" vs a head "favorite tea is green tea"): belief updates that never
 * landed. An LLM judge now labels each candidate against the current head:
 *
 *   same        → `merged` (the head already holds it)
 *   refines     → promoted through `resolveBeliefCandidate` → `believe()`, which
 *                 supersedes the head, so the supersession chain stays intact
 *   contradicts → stays `conflicted`, tagged so the brief can surface it
 *                 (`listOpenContradictions`)
 *   unrelated   → stays `conflicted` (a topic-key collision, not a fact change)
 *
 * The judge never promotes on uncertainty: a missing verdict, a parse failure or
 * an unavailable LLM returns no verdict and the caller keeps its old behavior.
 */

export type ReconcileVerdict = 'same' | 'refines' | 'contradicts' | 'unrelated';

/** `resolved_reason` tags written on judged rows. `conflicted` + JUDGE_CONTRADICTS
 *  is the open-contradiction queue; an untagged `conflicted` row was never judged. */
export const JUDGE_REASON: Record<ReconcileVerdict, string> = {
  same: 'judge:same',
  refines: 'judge:refines',
  contradicts: 'judge:contradicts',
  unrelated: 'judge:unrelated',
};
/** A refinement held back because it would overwrite a first-party head with a
 *  weaker-provenance claim (corrections write first-party heads). */
export const JUDGE_REFINES_WEAKER = 'judge:refines-weaker';

/** @deprecated Read `getTuning()`. Kept for external importers; always the defaults. */
export const RECONCILE_BATCH = DEFAULT_TUNING.reconcileBatch;
/** @deprecated */
export const RECONCILE_MAX_PER_RUN = DEFAULT_TUNING.reconcileMaxPerRun;
/** @deprecated */
export const EXPIRED_LOOKBACK_DAYS = DEFAULT_TUNING.expiredLookbackDays;

export interface BeliefHead {
  id: number;
  claim: string;
  ts: string;
  provenance: string | null;
}

/**
 * Latest non-retracted `belief.update` for an EXACT topic slug — the same lookup
 * the promotion pass has always used for its contradiction check.
 */
export function currentHead(db: RobinDb, topic: string): BeliefHead | undefined {
  const row = db
    .prepare(
      `SELECT e.id AS id, c.body AS claim, e.ts AS ts,
              json_extract(e.payload, '$.provenance') AS provenance
         FROM events e
         LEFT JOIN events_content c ON c.id = e.content_ref
        WHERE e.kind = 'belief.update'
          AND json_extract(e.payload, '$.topic') = ?
          AND (json_extract(e.payload, '$.retracted') IS NULL
            OR json_extract(e.payload, '$.retracted') = 0
            OR json_extract(e.payload, '$.retracted') = false)
        ORDER BY e.ts DESC, e.id DESC
        LIMIT 1`,
    )
    .get(topic) as
    | { id: number; claim: string | null; ts: string; provenance: string | null }
    | undefined;
  if (!row?.claim) return undefined;
  return { id: row.id, claim: row.claim, ts: row.ts, provenance: row.provenance };
}

export interface JudgeItem {
  /** Caller's key (the candidate id). */
  id: number;
  topic: string;
  claim: string;
  head: BeliefHead;
}

const VerdictSchema = z.object({
  verdicts: z.array(
    z.object({
      item: z.number(),
      verdict: z.enum(['same', 'refines', 'contradicts', 'unrelated']),
    }),
  ),
});

type Verdicts = z.infer<typeof VerdictSchema>['verdicts'];

function parseVerdicts(structured: unknown, text: string): Verdicts | null {
  const direct = VerdictSchema.safeParse(structured);
  if (direct.success) return direct.data.verdicts;
  // Fallback: first JSON object in the text.
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const parsed = VerdictSchema.safeParse(JSON.parse(m[0]));
    return parsed.success ? parsed.data.verdicts : null;
  } catch {
    return null;
  }
}

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s);

/**
 * Judge each item's candidate against its head, in batches of `batchSize`. Returns
 * verdicts keyed by item id. A batch whose call throws or fails to parse yields no
 * verdicts for its items — callers fall back for anything missing. `llm` null →
 * empty map.
 */
export async function judgeAgainstHeads(
  llm: LLMDispatcher | null,
  items: JudgeItem[],
  batchSize = getTuning().reconcileBatch,
): Promise<Map<number, ReconcileVerdict>> {
  const out = new Map<number, ReconcileVerdict>();
  if (!llm || items.length === 0) return out;
  for (let start = 0; start < items.length; start += batchSize) {
    const batch = items.slice(start, start + batchSize);
    const lines = batch
      .map((it, n) =>
        [
          `ITEM ${n} (topic '${it.topic}')`,
          `  current (${it.head.ts.slice(0, 10)}): ${clip(it.head.claim, 400)}`,
          `  new: ${clip(it.claim, 400)}`,
        ].join('\n'),
      )
      .join('\n');
    let verdicts: Verdicts | null;
    try {
      const res = await llm.invoke('classify', {
        systemPrompt: getPrompt('reconcile.judge'),
        messages: [{ role: 'user', content: lines }],
        outputSchema: VerdictSchema,
        temperature: 0,
        maxTokens: 1024,
      });
      verdicts = parseVerdicts(res.structured, res.text);
    } catch {
      verdicts = null; // LLM unavailable — no verdicts for this batch
    }
    if (!verdicts) continue;
    for (const v of verdicts) {
      const it = batch[v.item];
      // First verdict per item wins; a duplicated item index can't flip it.
      if (it && !out.has(it.id)) out.set(it.id, v.verdict);
    }
  }
  return out;
}

export interface CandidateForVerdict {
  id: number;
  topic: string;
  provenance: string | null;
}

export type AppliedOutcome =
  | 'merged'
  | 'promoted'
  | 'gate-blocked'
  | 'contradiction'
  | 'unrelated'
  | 'refines-weaker';

/**
 * Write one verdict. The candidate may be `pending`, `conflicted`, or rejected by
 * stale-conflict expiry (backfill); every branch sets status explicitly.
 * `refines` reopens the row as `pending` and promotes it via
 * `resolveBeliefCandidate`, so the P3 formation gates and `believe()`'s
 * supersession both apply — in one transaction, so a throw leaves the row as it was.
 */
export function applyVerdict(
  db: RobinDb,
  cand: CandidateForVerdict,
  head: BeliefHead,
  verdict: ReconcileVerdict,
  llm: LLMDispatcher | null = null,
): AppliedOutcome {
  const setRow = (status: string, reason: string) =>
    db
      .prepare(
        `UPDATE belief_candidates SET status = ?, resolved_at = datetime('now'), resolved_reason = ? WHERE id = ?`,
      )
      .run(status, reason, cand.id);

  if (verdict === 'same') {
    setRow('merged', JUDGE_REASON.same);
    return 'merged';
  }
  if (verdict === 'contradicts') {
    setRow('conflicted', JUDGE_REASON.contradicts);
    return 'contradiction';
  }
  if (verdict === 'unrelated') {
    setRow('conflicted', JUDGE_REASON.unrelated);
    return 'unrelated';
  }
  // refines. A first-party head (the operator's own word, and every correction replay)
  // is never superseded by a weaker-provenance claim on the judge's say-so alone.
  if (head.provenance === 'first-party' && cand.provenance !== 'first-party') {
    setRow('conflicted', JUDGE_REFINES_WEAKER);
    return 'refines-weaker';
  }
  return db.transaction((): AppliedOutcome => {
    db.prepare(
      `UPDATE belief_candidates SET status = 'pending', resolved_at = NULL, resolved_reason = NULL WHERE id = ?`,
    ).run(cand.id);
    const res = resolveBeliefCandidate(db, llm, cand.id, 'promote');
    if (res.blockedReason) {
      db.prepare(`UPDATE belief_candidates SET resolved_reason = ? WHERE id = ?`).run(
        res.blockedReason,
        cand.id,
      );
      return 'gate-blocked';
    }
    db.prepare(`UPDATE belief_candidates SET resolved_reason = ? WHERE id = ?`).run(
      JUDGE_REASON.refines,
      cand.id,
    );
    return 'promoted';
  })();
}

// ── Backfill: `robin beliefs reconcile` ──────────────────────────────────────

export interface ReconcileOpts {
  /** Write verdicts. Default false: judge and report only. */
  apply?: boolean;
  /** Also re-judge candidates rejected by stale-conflict expiry in the lookback. */
  includeExpired?: boolean;
  /** Cap on candidates judged in this run. Default: all. */
  limit?: number;
  batchSize?: number;
  now?: Date;
}

export interface ReconcileDecision {
  id: number;
  topic: string;
  claim: string;
  headClaim: string;
  /** 'conflicted' or 'expired' — where the candidate came from. */
  from: 'conflicted' | 'expired';
  verdict: ReconcileVerdict | null;
  /** What was (or, in dry-run, would be) written. */
  outcome: AppliedOutcome | 'unchanged' | 'no-verdict' | 'no-head' | 'skipped-topic';
}

export interface ReconcileReport {
  considered: number;
  judged: number;
  decisions: ReconcileDecision[];
  counts: Record<string, number>;
}

interface BacklogRow {
  id: number;
  topic: string;
  claim: string;
  provenance: string | null;
  status: string;
}

/**
 * Re-judge the conflicted backlog (and, with `includeExpired`, conflicts rejected
 * by stale-conflict expiry in the last 120 days). Dry-run by default.
 *
 * Expired rows are only reopened when the verdict is `same` (→ merged) or
 * `refines` (→ promoted); a contradiction or collision that already expired stays
 * expired. At most one refinement promotes per topic per run — a second one was
 * judged against a head that the first just superseded — so later ones on that
 * topic are skipped and pick up against the new head next run.
 */
export async function reconcileConflicts(
  db: RobinDb,
  llm: LLMDispatcher | null,
  opts: ReconcileOpts = {},
): Promise<ReconcileReport> {
  const now = opts.now ?? clockDate();
  const cutoff = new Date(now.getTime() - getTuning().expiredLookbackDays * 86_400_000)
    .toISOString()
    .slice(0, 19)
    .replace('T', ' ');
  const rows = db
    .prepare(
      `SELECT id, topic, claim, provenance, status FROM belief_candidates
        WHERE status = 'conflicted'
           OR (? = 1 AND status = 'rejected' AND resolved_reason = 'stale-conflict-expiry'
               AND resolved_at >= ?)
        ORDER BY id`,
    )
    .all(opts.includeExpired ? 1 : 0, cutoff) as BacklogRow[];
  const pool = opts.limit != null ? rows.slice(0, opts.limit) : rows;

  const report: ReconcileReport = { considered: pool.length, judged: 0, decisions: [], counts: {} };
  const heads = new Map<number, BeliefHead | undefined>();
  const items: JudgeItem[] = [];
  for (const r of pool) {
    const head = currentHead(db, r.topic);
    heads.set(r.id, head);
    if (head) items.push({ id: r.id, topic: r.topic, claim: r.claim, head });
  }
  const verdicts = await judgeAgainstHeads(
    llm,
    items,
    opts.batchSize ?? getTuning().reconcileBatch,
  );
  report.judged = verdicts.size;

  const refinedTopics = new Set<string>();
  for (const r of pool) {
    const head = heads.get(r.id);
    const from = r.status === 'conflicted' ? 'conflicted' : 'expired';
    const verdict = verdicts.get(r.id) ?? null;
    const base = {
      id: r.id,
      topic: r.topic,
      claim: r.claim,
      headClaim: head?.claim ?? '',
      from,
      verdict,
    } as const;
    let outcome: ReconcileDecision['outcome'];
    if (!head) outcome = 'no-head';
    else if (!verdict) outcome = 'no-verdict';
    else if (from === 'expired' && (verdict === 'contradicts' || verdict === 'unrelated')) {
      outcome = 'unchanged';
    } else if (verdict === 'refines' && refinedTopics.has(r.topic)) {
      outcome = 'skipped-topic';
    } else if (opts.apply) {
      if (verdict === 'refines') refinedTopics.add(r.topic);
      try {
        outcome = applyVerdict(db, r, head, verdict, llm);
      } catch {
        outcome = 'unchanged';
      }
    } else {
      if (verdict === 'refines') refinedTopics.add(r.topic);
      outcome = predictOutcome(r, head, verdict);
    }
    report.decisions.push({ ...base, outcome });
    report.counts[outcome] = (report.counts[outcome] ?? 0) + 1;
  }
  return report;
}

/** Dry-run preview of `applyVerdict` (gate-blocks are only known on apply). */
function predictOutcome(
  cand: CandidateForVerdict,
  head: BeliefHead,
  verdict: ReconcileVerdict,
): AppliedOutcome {
  if (verdict === 'same') return 'merged';
  if (verdict === 'contradicts') return 'contradiction';
  if (verdict === 'unrelated') return 'unrelated';
  if (head.provenance === 'first-party' && cand.provenance !== 'first-party') {
    return 'refines-weaker';
  }
  return 'promoted';
}
