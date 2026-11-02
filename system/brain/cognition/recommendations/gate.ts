import type { RobinDb } from '../../memory/db.ts';
import {
  findOpenBySubject,
  findOpenOverlapping,
  type InsertRecommendationInput,
  insertRecommendation,
  normalizeSubject,
  noteReRecommended,
  supersedeRecommendation,
} from './store.ts';

/**
 * Creation gate (design 2026-08-10 §4) — EVERY recommendation creation path goes
 * through here (MCP `recommend`, scan backfill, future scouts). Enforced in code
 * because prompt discipline demonstrably didn't hold (186 recs in 10 days; 72 in one
 * evening on 2026-09-13).
 *  - same open subject (normalized-equal) + same verdict → duplicate: bump evidence,
 *    no insert.
 *  - an open rec whose subject OVERLAPS (equal with a new verdict, or one subject
 *    contains the other — `subjectsOverlap`) → insert, supersede the prior rec(s).
 *  - fresh subject → plain insert.
 *  - past the per-session daily cap (`sessionCap`) → logged with status `suppressed`:
 *    kept for audit, but never an open loop and never superseding anything.
 * `makeSourceEventId` is called ONLY when a row is actually inserted, so the
 * duplicate path emits no provenance event.
 */
export type RecommendGateResult =
  | { action: 'inserted'; id: number }
  | { action: 'duplicate'; id: number }
  | { action: 'superseded'; id: number; supersededIds: number[] }
  | { action: 'suppressed'; id: number };

/** Confidence floor for scan/scout-born candidates (conversation recs exempt). */
export const MIN_SCAN_CONFIDENCE = 0.5;

/** Default per-session, per-day cap on recs that enter the open-loop list. */
export const DEFAULT_SESSION_DAILY_CAP = 15;

/**
 * Per-session daily creation counter. One instance lives in each MCP server process (a
 * stdio MCP server is spawned per client session, so process ≈ session); the key rolls
 * at local midnight, so a session that spans days gets a fresh allowance each day.
 */
export class SessionRecCounter {
  private day = '';
  private count = 0;

  constructor(
    readonly limit: number = DEFAULT_SESSION_DAILY_CAP,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  private roll(): void {
    const d = this.clock();
    const key = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
    if (key !== this.day) {
      this.day = key;
      this.count = 0;
    }
  }

  /** True when another open rec would exceed today's cap. */
  exhausted(): boolean {
    this.roll();
    return this.count >= this.limit;
  }

  /** Record one open rec created this session today. */
  bump(): void {
    this.roll();
    this.count += 1;
  }
}

export interface RecommendGateOptions {
  /** When given, recs beyond the counter's daily limit are inserted `suppressed`. */
  sessionCap?: SessionRecCounter;
}

export function applyRecommendGate(
  db: RobinDb,
  input: Omit<InsertRecommendationInput, 'sourceEventId' | 'status'>,
  makeSourceEventId?: () => number | null,
  opts: RecommendGateOptions = {},
): RecommendGateResult {
  const exact = findOpenBySubject(db, input.subject);
  const sameVerdict = exact.find((r) => (r.verdict ?? null) === (input.verdict ?? null));
  if (sameVerdict) {
    noteReRecommended(db, sameVerdict.id);
    return { action: 'duplicate', id: sameVerdict.id };
  }

  if (opts.sessionCap?.exhausted()) {
    const sourceEventId = makeSourceEventId ? makeSourceEventId() : null;
    const { id } = insertRecommendation(db, { ...input, sourceEventId, status: 'suppressed' });
    return { action: 'suppressed', id };
  }

  const prior = findOpenOverlapping(db, input.subject);
  const sourceEventId = makeSourceEventId ? makeSourceEventId() : null;
  const { id } = insertRecommendation(db, { ...input, sourceEventId });
  opts.sessionCap?.bump();
  const key = normalizeSubject(input.subject);
  const supersededIds: number[] = [];
  for (const p of prior) {
    const reason =
      normalizeSubject(p.subject) === key ? 'changed stance' : 'newer rec on the same subject';
    supersedeRecommendation(db, p.id, id, reason);
    supersededIds.push(p.id);
  }
  return supersededIds.length > 0
    ? { action: 'superseded', id, supersededIds }
    : { action: 'inserted', id };
}
