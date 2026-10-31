import { subjectMatches } from './store.ts';
import type { Verdict } from './types.ts';

/**
 * Open-loops ranking (design 2026-08-10 §5) — a PURE function, no DB, no LLM.
 * Score = urgency (hyperbolic in days-to-expiry) + 0.5·confidence + a flat
 * context boost when the item's subject appears in a context text (calendar
 * titles / month / season). Domain rotation greedily caps ranked slots per
 * domain so one domain can't monopolize the brief.
 */

const MS_PER_DAY = 86_400_000;
const CONTEXT_BOOST = 0.75;
const NO_EXPIRY_URGENCY_DAYS = 90; // legacy null-expiry rows rank as far-out

export interface OpenLoopItem {
  id: number;
  subject: string;
  claim: string;
  verdict: Verdict | null;
  domain: string;
  confidence: number;
  createdAtMs: number;
  expiresAtMs: number | null;
}

export interface RankContext {
  nowMs: number;
  /** Calendar titles for the coming week + current month/season words. */
  contextTexts: string[];
}

export interface RankOptions {
  rankedSlots?: number; // default 5
  lastCallSlots?: number; // default 2
  maxPerDomain?: number; // default 3
  lastCallWithinDays?: number; // default 7
}

export interface RankResult {
  ranked: OpenLoopItem[];
  lastCall: OpenLoopItem[];
  /** Last-call-eligible items that did NOT fit the slots (spec §5 overflow metric). */
  lastCallOverflow: number;
}

export function scoreOpenLoop(item: OpenLoopItem, ctx: RankContext): number {
  const daysToExpiry =
    item.expiresAtMs == null
      ? NO_EXPIRY_URGENCY_DAYS
      : Math.max(0, (item.expiresAtMs - ctx.nowMs) / MS_PER_DAY);
  const urgency = 1 / (daysToExpiry + 2);
  const boost = ctx.contextTexts.some((t) => subjectMatches(t, item.subject)) ? CONTEXT_BOOST : 0;
  return urgency + 0.5 * item.confidence + boost;
}

/** Hold-type stances (mirror of store.ts HOLD_VERDICTS — rank stays DB-free). */
const HOLD: ReadonlySet<string> = new Set(['skip', 'avoid', 'wait']);

/**
 * Items eligible for the last-call slots: lapsing within the window, soonest first.
 * Skip/avoid/wait stances are NOT eligible — their lapse resolves `held` (the advice
 * held), so there is no action to prompt before it closes.
 */
export function lastCallEligible(
  items: OpenLoopItem[],
  nowMs: number,
  opts: Pick<RankOptions, 'lastCallWithinDays'> = {},
): OpenLoopItem[] {
  const withinMs = (opts.lastCallWithinDays ?? 7) * MS_PER_DAY;
  return items
    .filter(
      (i) =>
        !(i.verdict != null && HOLD.has(i.verdict)) &&
        i.expiresAtMs != null &&
        i.expiresAtMs >= nowMs &&
        i.expiresAtMs < nowMs + withinMs,
    )
    .sort((a, b) => (a.expiresAtMs ?? 0) - (b.expiresAtMs ?? 0));
}

/**
 * The last-call overflow: eligible lapsing items that did NOT fit the `lastCallSlots`
 * (audit 2026-10-02: 2 slots vs ~35 eligible → ~33/day lapsed unseen). The brief renders
 * it via `formatLastCallOverflow`.
 */
export function lastCallOverflowCount(
  items: OpenLoopItem[],
  nowMs: number,
  opts: Pick<RankOptions, 'lastCallSlots' | 'lastCallWithinDays'> = {},
): number {
  return Math.max(0, lastCallEligible(items, nowMs, opts).length - (opts.lastCallSlots ?? 2));
}

/** The brief line for the overflow — '' when nothing overflows. */
export function formatLastCallOverflow(overflow: number, withinDays = 7): string {
  if (overflow <= 0) return '';
  return `+${overflow} more lapsing in the next ${withinDays} days (\`robin recommendations --status=open\`)`;
}

export function rankOpenLoops(
  items: OpenLoopItem[],
  ctx: RankContext,
  opts: RankOptions = {},
): RankResult {
  const rankedSlots = opts.rankedSlots ?? 5;
  const lastCallSlots = opts.lastCallSlots ?? 2;
  const maxPerDomain = opts.maxPerDomain ?? 3;

  // Last-call first: soonest-lapsing wins the guaranteed final appearance.
  const eligible = lastCallEligible(items, ctx.nowMs, opts);
  const lastCall = eligible.slice(0, lastCallSlots);
  const lastCallOverflow = Math.max(0, eligible.length - lastCallSlots);
  const taken = new Set(lastCall.map((i) => i.id));

  // Ranked slots: greedy by score with the per-domain cap.
  const pool = items
    .filter((i) => !taken.has(i.id))
    .map((i) => ({ i, score: scoreOpenLoop(i, ctx) }))
    .sort((a, b) => b.score - a.score);
  const ranked: OpenLoopItem[] = [];
  const perDomain = new Map<string, number>();
  for (const { i } of pool) {
    if (ranked.length >= rankedSlots) break;
    const used = perDomain.get(i.domain) ?? 0;
    if (used >= maxPerDomain) continue;
    perDomain.set(i.domain, used + 1);
    ranked.push(i);
  }
  return { ranked, lastCall, lastCallOverflow };
}
