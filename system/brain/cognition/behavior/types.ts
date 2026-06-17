import type { PersonalDomain } from '../../memory/domains.ts';

/**
 * Behavioral Habit Inference (Phase 2) — core types.
 * Design ref: docs/design/2026-06-17-behavioral-habit-inference-design.md §3, §4.
 */

/**
 * A habit's lifecycle state.
 *  - `soft`      — default; a hint-grade tendency, never rendered as fact.
 *  - `graduated` — cleared the §8 graduation gate and spawned a `preferences`
 *                  belief_candidate (`graduated_belief_id`); still rendered hedged
 *                  until that candidate promotes.
 *  - `retired`   — past staleness/low-confidence floor OR vetoed via record_correction;
 *                  its embedding joins the suppression set so the pattern never returns.
 */
export type HabitStatus = 'soft' | 'graduated' | 'retired';

/**
 * The five behavioral pattern kinds (spec §4). `pattern_kind` is currently a fixed
 * union (open question §13: whether it stays fixed or becomes extensible).
 */
export type PatternKind = 'purchase' | 'temporal' | 'preference' | 'workflow' | 'consumption';

/**
 * A stored habit — a generalization over many behavioral signals. Mirrors the
 * `habits` table (migration 030) one-to-one, mapped to camelCase.
 *
 * `confidence` is engine-owned and recomputed from state (§6), never an
 * incrementally-mutated counter. `evidenceSummary` is the durable audit trail that
 * survives source-event purges; `evidenceEventIds` may dangle after purges.
 */
export interface Habit {
  id: number;
  /** The habit phrased as a hedged tendency ("tends to buy camera gear before a planned trip"). */
  statement: string;
  /** Primary domain; a member of PERSONAL_DOMAINS (same gate as beliefs). */
  domain: PersonalDomain;
  patternKind: PatternKind;
  /** 0..1, soft; engine-owned (§6). */
  confidence: number;
  /** # distinct supporting signals. */
  supportCount: number;
  /** # distinct *streams* contributing (single-stream patterns stay weak). */
  supportStreams: number;
  /** Best-effort; a demotion/retire signal, NOT a graduation gate input. */
  contradictionCount: number;
  /** Source event ids (may dangle after purges). */
  evidenceEventIds: number[];
  /** Text snapshot of supporting signals at inference time — survives event purges. */
  evidenceSummary: string;
  /** Vector for semantic dedup/upsert + retired-suppression matching; null until embedded. */
  embedding: Float32Array | null;
  /** Observation window start (ISO/SQLite-utc). */
  firstSeen: string;
  /** Observation window end. */
  lastSeen: string;
  /** Drives the confidence recency term. */
  lastReinforced: string;
  status: HabitStatus;
  /** FK → the `preferences` belief_candidate spawned on graduation; null otherwise. */
  graduatedBeliefId: number | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * A behavioral signal = an already-captured event reflecting something Kevin did or
 * chose, normalized at read-time to a common shape (spec §3). Phase 2 does NOT capture
 * these anew — it reads the firehose through the BEHAVIORAL_SIGNAL_KINDS allowlist and
 * normalizes them here.
 */
export interface BehavioralSignal {
  /** Who acted — normalized to the user (signals exclude Robin's own outputs, §11). */
  actor: string;
  /** What happened (a verb-ish label, e.g. "purchase", "shoot", "watch", "decide"). */
  action: string;
  /** What it was about (free text — a merchant/title/subject; '' when unknown). */
  object: string;
  /** Primary domain (PERSONAL_DOMAINS) inferred from the source stream. */
  domain: PersonalDomain;
  /** Event timestamp (ISO string, as stored on the event row). */
  ts: string;
  /** Lightweight extra context lifted from the payload (merchant, amount, tags, …). */
  context: Record<string, unknown>;
  /** The source event id (for evidence trails). */
  sourceEventId: number;
  /** The source event `kind` string (the stream this signal came from). */
  sourceKind: string;
}
