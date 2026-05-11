// decay.js — JS mirror of fn::freshness for in-Node ranking.
//
// Spec §6.6, §5.2. The DB function `fn::freshness(memo)` is the canonical
// scorer for server-side ORDER BY; this JS version is for client-side ranking
// when we already have the memo row and a count of inbound `supersedes` edges
// hydrated (one round-trip saved per result).
//
// Half-lives (ms) by memo kind — same constants as in 0001-init.surql.

export const HALF_LIFE_BY_KIND_MS = {
  knowledge: 180 * 24 * 60 * 60 * 1000, // 180d
  habit: 60 * 24 * 60 * 60 * 1000, // 60d
  thread: 30 * 24 * 60 * 60 * 1000, // 30d
  prediction: 365 * 24 * 60 * 60 * 1000, // 365d
};

const DEFAULT_HALF_LIFE_MS = 90 * 24 * 60 * 60 * 1000; // 90d default

/**
 * Compute freshness ∈ [0, 1] for a memo row.
 *
 * Returns 0 if the memo has any inbound `supersedes` edge (caller supplies
 * `supersededCount` from a batched query — avoids a per-memo round-trip).
 *
 * @param {{
 *   kind: string,
 *   confidence?: number,
 *   signal_count?: number,
 *   decay_anchor?: Date | string,
 * }} memo
 * @param {{ supersededCount?: number, now?: Date }} [opts]
 * @returns {number}
 */
export function freshness(memo, opts = {}) {
  const supersededCount = opts.supersededCount ?? 0;
  if (supersededCount > 0) return 0;
  const halfLifeMs = HALF_LIFE_BY_KIND_MS[memo.kind] ?? DEFAULT_HALF_LIFE_MS;
  const confidence = memo.confidence ?? 0.5;
  const signalCount = memo.signal_count ?? 1;
  const anchor =
    memo.decay_anchor instanceof Date
      ? memo.decay_anchor
      : new Date(memo.decay_anchor ?? Date.now());
  const now = opts.now instanceof Date ? opts.now : new Date();
  const ageMs = Math.max(0, now.getTime() - anchor.getTime());
  const decay = Math.pow(0.5, ageMs / halfLifeMs);
  const reinforced = Math.log2(1 + signalCount);
  return Math.min(1, confidence * decay * reinforced);
}
