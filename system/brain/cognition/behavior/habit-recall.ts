import type { RobinDb } from '../../memory/db.ts';
import { listHabits } from './habits-store.ts';
import type { Habit } from './types.ts';

/**
 * Behavioral Habit Inference (Phase 2) — the personalization wire (design §9, Goal A)
 * and the optional brief surface (design §10, Goal B).
 *
 * A habit is useless if Robin can't see it while it reasons. This module turns stored
 * habits into:
 *  1. `selectHabitInjections` — a SMALL, topically-ranked slice for the per-turn
 *     auto-recall hook, labeled even softer than memory ("inferred tendency — hint, not
 *     fact"). It ranks habit embeddings against the SAME turn-query embedding the factual
 *     recall path already computed (passed in — never re-embedded here) and returns at
 *     most `cap` hits above a relevance threshold. Its own budget; it NEVER touches the
 *     factual block's slots (design §9, the augment-not-degrade guards).
 *  2. `selectBriefHabitLine` — one optional "Behavioral note:" line from a graduated /
 *     strongly-reinforced habit for the daily brief (design §10).
 *
 * Both paths exclude SENSITIVE_DOMAINS from unprompted/loose surfacing: a sensitive
 * habit needs a much stricter topical match to inject as a hint, and is never surfaced
 * in the brief at all (design §11 guardrails).
 */

/**
 * Sensitive domains (design §11): health, finance, relationships. Mirrors the
 * PERSONAL_DOMAINS string-set idiom (domains.ts) but is a LOCAL subset — these stay
 * `soft` permanently and are gated harder than the rest:
 *  - injected as a hint only on a strongly on-topic turn (SENSITIVE_INJECT_MIN_SIM),
 *  - never surfaced unprompted in the brief.
 */
export const SENSITIVE_DOMAINS: ReadonlySet<string> = new Set([
  'health',
  'finance',
  'relationships',
]);

/**
 * Cosine relevance floors for the per-turn hint slice. Habit embeddings come from the
 * SAME `embed` role as the recall query (embed-content.embedBody → dispatcher.embed),
 * so cosine between the two is meaningful. The factual recall floor is an L2 distance of
 * 0.82 (auto-recall.AUTO_RECALL_MAX_DISTANCE); for ~unit-norm Gemini vectors that maps to
 * cosine ≈ 0.66. We sit the NORMAL hint floor just under that (0.60) — a hint is softer
 * than a fact, but still only fires when the turn is genuinely on-topic, never as ambient
 * noise. SENSITIVE is far stricter (0.78) so a health/finance/relationships tendency can
 * only leak in when the turn is unmistakably about that domain.
 */
const NORMAL_INJECT_MIN_SIM = 0.6;
const SENSITIVE_INJECT_MIN_SIM = 0.78;

/** Default cap on injected hints (design §9: "top 1–2"). Its own budget, never the factual one. */
const DEFAULT_INJECT_CAP = 2;

/** Cosine similarity over two equal-length vectors; 0 when either is a zero vector. */
function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export interface HabitInjection {
  habitId: number;
  statement: string;
  domain: string;
  similarity: number;
  /** The hedged, hint-grade line to inject — clearly NOT a fact. */
  line: string;
}

export interface SelectHabitInjectionsOpts {
  /** Max hints returned (design §9 "top 1–2"). Defaults to 2. */
  cap?: number;
  /** Normal-domain cosine floor. Defaults to NORMAL_INJECT_MIN_SIM. */
  minSimilarity?: number;
  /** Sensitive-domain cosine floor (stricter). Defaults to SENSITIVE_INJECT_MIN_SIM. */
  sensitiveMinSimilarity?: number;
}

/**
 * Build the SOFTER-labeled hint line for one habit. The prefix is deliberately
 * un-factual so the model treats it as a tendency, never a stated truth (design §9).
 */
export function habitHintLine(statement: string): string {
  return `inferred tendency (hint, not fact): ${statement.trim()}`;
}

/**
 * Rank `soft`/`graduated` habits with a non-null embedding against the (already-computed)
 * turn-query embedding by cosine, and return the top `cap` that clear their relevance
 * floor — sensitive domains held to a much stricter floor. Returns [] when there are no
 * embedded habits or none clear the bar (so the caller injects nothing and the factual
 * block stays byte-identical).
 *
 * `queryEmbedding` is the EXACT vector the factual recall path embedded this turn — reused,
 * never recomputed (the whole point of the wire is zero extra embed cost).
 */
export function selectHabitInjections(
  db: RobinDb,
  queryEmbedding: ArrayLike<number>,
  opts: SelectHabitInjectionsOpts = {},
): HabitInjection[] {
  if (!queryEmbedding || queryEmbedding.length === 0) return [];
  const cap = opts.cap ?? DEFAULT_INJECT_CAP;
  if (cap <= 0) return [];
  const normalFloor = opts.minSimilarity ?? NORMAL_INJECT_MIN_SIM;
  const sensitiveFloor = opts.sensitiveMinSimilarity ?? SENSITIVE_INJECT_MIN_SIM;

  // Candidates: soft + graduated only (retired habits must never resurface). Embedded only.
  const candidates: Habit[] = [...listHabits(db, 'soft'), ...listHabits(db, 'graduated')].filter(
    (h) => h.embedding != null && h.embedding.length > 0,
  );
  if (candidates.length === 0) return [];

  const scored: HabitInjection[] = [];
  for (const h of candidates) {
    // embedding non-null guaranteed by the filter above.
    const sim = cosine(queryEmbedding, h.embedding as Float32Array);
    const floor = SENSITIVE_DOMAINS.has(h.domain) ? sensitiveFloor : normalFloor;
    if (sim < floor) continue;
    scored.push({
      habitId: h.id,
      statement: h.statement,
      domain: h.domain,
      similarity: sim,
      line: habitHintLine(h.statement),
    });
  }

  scored.sort((a, b) => b.similarity - a.similarity);
  return scored.slice(0, cap);
}

/**
 * Pick at most ONE habit for the daily brief's optional "Behavioral note:" line
 * (design §10, Goal B). Drawn from `graduated` habits (strongly-reinforced, gate-cleared),
 * with SENSITIVE_DOMAINS excluded from this unprompted surface. Highest-confidence first;
 * `listHabits` already orders newest-reinforced first, so confidence is the tiebreak that
 * picks the most-established pattern. Returns null when nothing qualifies (the brief then
 * renders no line at all — no empty section).
 */
export function selectBriefHabitLine(db: RobinDb): string | null {
  const graduated = listHabits(db, 'graduated').filter((h) => !SENSITIVE_DOMAINS.has(h.domain));
  if (graduated.length === 0) return null;
  // Most-established first: highest confidence, then most-recently reinforced (list order).
  let best = graduated[0];
  for (const h of graduated) {
    if (h.confidence > best.confidence) best = h;
  }
  return `Behavioral note: ${best.statement.trim()}`;
}
