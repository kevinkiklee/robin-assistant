import type { PersonalDomain } from '../../memory/domains.ts';

/**
 * Recommendation→Action Loop (Phase 1) — core types.
 * Design ref: docs/design/2026-06-17-recommendation-loop-design.md §3.
 */

/**
 * A recommendation's lifecycle state (mirrors the `predictions` lifecycle).
 *  - `open`       — default; recorded, not yet acted on, not yet expired.
 *  - `acted`      — the operator acted on it (a matching behavioral signal, or a manual resolve).
 *  - `declined`   — the operator explicitly declined it (manual resolve only).
 *  - `expired`    — went past `expires_at` unacted → resolved `not_acted`.
 *  - `superseded` — replaced by a newer recommendation about the same subject.
 *  - `held`       — a skip/avoid/wait stance whose window passed with no contrary action:
 *                   the advice held. Following a "don't" means NOT acting, so these are
 *                   excluded from the acted-rate denominator (audit 2026-10-02).
 *  - `suppressed` — logged past the per-session daily creation cap; kept for audit, never
 *                   an open loop, never linked, never calibrated.
 */
export type RecommendationStatus =
  | 'open'
  | 'acted'
  | 'declined'
  | 'expired'
  | 'superseded'
  | 'held'
  | 'suppressed';

/**
 * The resolved outcome of a recommendation (mirrors `prediction.outcome`):
 *  - `acted`     — the operator acted on the advice.
 *  - `not_acted` — the operator did not act (expired, or explicitly declined).
 *  - `unknown`   — undetermined.
 */
export type RecommendationOutcome = 'acted' | 'not_acted' | 'unknown';

/**
 * Robin's optional stance on the recommended thing. `other` is the catch-all for advice
 * that is not a buy/skip/wait/try/avoid judgment.
 */
export type Verdict = 'buy' | 'skip' | 'wait' | 'try' | 'avoid' | 'other';

/**
 * A stored recommendation — mirrors the `recommendations` table (migration 031)
 * one-to-one, mapped to camelCase. `subject` is the linker's match key (§3, §5).
 */
export interface Recommendation {
  id: number;
  /** Short canonical name of the recommended thing ("Acme kettle") — the match key. */
  subject: string;
  /** The recommendation text/advice. */
  claim: string;
  /** Why Robin recommended it; null when unspecified. */
  reasoning: string | null;
  /** Optional stance; null when unspecified. */
  verdict: Verdict | null;
  /** Calibration-grouping bucket; a member of PERSONAL_DOMAINS. */
  domain: PersonalDomain;
  /** 0..1, Robin's confidence in the recommendation. */
  confidence: number;
  createdAt: string;
  /** Where the rec was made (FK → events; may dangle/null after purges). */
  sourceEventId: number | null;
  /** Optional; after this an unacted rec resolves `not_acted`. Null = no explicit expiry. */
  expiresAt: string | null;
  status: RecommendationStatus;
  /** Resolved outcome; null while open. */
  outcome: RecommendationOutcome | null;
  /** When the action was detected; null while open. */
  actedAt: string | null;
  /** The behavioral signal/event that fulfilled it (FK → events; null otherwise). */
  actionEventId: number | null;
  /** How the link was established (durable audit; survives event purge). */
  evidence: string | null;
}
