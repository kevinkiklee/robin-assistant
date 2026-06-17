import { z } from 'zod';
import { createLogger } from '../../../lib/logging/logger.ts';
import type { LLMDispatcher } from '../../llm/dispatcher.ts';
import type { RobinDb } from '../../memory/db.ts';
import { isPersonalDomain, type PersonalDomain } from '../../memory/domains.ts';
import { embedBody } from '../../memory/embed-content.ts';
import { computeConfidence } from './confidence.ts';
import { getSynthesizeCursor, setSynthesizeCursor } from './cursor.ts';
import { graduateHabit, meetsGraduationGate, NON_GRADUATING_DOMAINS } from './graduation.ts';
import {
  findNearestHabitByEmbedding,
  insertHabit,
  listHabits,
  listRetiredEmbeddings,
  recomputeConfidenceFor,
  setHabitStatus,
  updateHabitReinforcement,
} from './habits-store.ts';
import { selectNewSignals } from './signals.ts';
import type { BehavioralSignal, Habit, PatternKind } from './types.ts';

/**
 * Behavioral Habit Inference (Phase 2) — Tier B: weekly, LLM StructuredOutput synthesis.
 * Design ref: docs/design/2026-06-17-behavioral-habit-inference-design.md §5 (Tier B), §7, §8.
 *
 * Tier B owns ALL semantic attribution: deciding a purchase instances an abstract
 * pattern, proposing NEW candidate habits, and merges. It enforces:
 *  - the §7 creation floor (≥2 instances across distinct time-spans AND ≥2 streams),
 *  - embedding-dedup upsert (no paraphrase twins),
 *  - engine-enforced retired-suppression (§8) — embedding-match every proposal against
 *    the retired set, not prompt-trusted,
 *  - a per-run budget; skip-on-empty (no new staged signals) and skip-on-no-LLM,
 *  - prioritized signal cap (decision/purchase > consumption), overflow logged + deferred
 *    via the cursor — never silently dropped,
 *  - graduation via the §8 gate (see graduation.ts).
 */

const log = createLogger({ module: 'behavior' });

/**
 * Per-run signal cap. Bounds the StructuredOutput prompt so one weekly call never blows
 * its budget/context. When more signals are staged, the cursor advances only past the
 * consumed rows so the remainder is processed (deferred, not dropped) on the next run.
 * Sized for a weekly cadence over Robin's behavioral streams (purchases + photo cadence
 * + films + whoop aggregates + session decisions); the overflow path is logged.
 */
const SIGNAL_CAP = 200;

/**
 * Per-run cost budget (USD), modeled on the dream-synthesis `SPECIALIST_BUDGET_USD` fix
 * (a fixed per-specialist cap that has to sit ABOVE one Opus-4.8 turn's cost so the turn
 * isn't aborted post-output). Tier B makes ONE structured call; we bound its generation
 * pre-call with `maxTokens` and verify the realized `costUsd` post-call, discarding the
 * pass (no writes) and logging if it blew the budget — the no-silent-overspend discipline.
 */
const SYNTHESIS_BUDGET_USD = 2.0;

/** Generation cap for the single synthesis call — bounds cost pre-flight. */
const SYNTHESIS_MAX_TOKENS = 4096;

/**
 * Cosine threshold for engine-enforced retired-suppression (§8). A proposed habit whose
 * embedding matches a retired pattern at/above this is dropped — a vetoed/retired pattern
 * can never resurrect. Matches the conservative dedup threshold used across the memory
 * stores (belief-candidate + habits-store both use 0.92).
 */
const RETIRED_SUPPRESS_THRESHOLD = 0.92;

/** Initial support count credited to a brand-new habit (the ≥2 instances that cleared §7). */
const INITIAL_SUPPORT_COUNT = 2;
/** Initial distinct-stream count for a new habit (the ≥2 streams that cleared §7). */
const INITIAL_SUPPORT_STREAMS = 2;

const PATTERN_KINDS: ReadonlySet<string> = new Set<PatternKind>([
  'purchase',
  'temporal',
  'preference',
  'workflow',
  'consumption',
]);

/** StructuredOutput schema — the one LLM call's contract (§5.B.2). */
const synthesisSchema = z.object({
  reinforcements: z
    .array(
      z.object({
        habitId: z.number().int(),
        evidenceEventIds: z.array(z.number().int()).default([]),
        evidenceSummary: z.string().default(''),
      }),
    )
    .default([]),
  newHabits: z
    .array(
      z.object({
        statement: z.string(),
        domain: z.string(),
        patternKind: z.string(),
        evidenceEventIds: z.array(z.number().int()).default([]),
        evidenceSummary: z.string().default(''),
        distinctTimeSpans: z.number().int().default(0),
        distinctStreams: z.number().int().default(0),
      }),
    )
    .default([]),
  merges: z
    .array(
      z.object({
        fromStatement: z.string(),
        intoHabitId: z.number().int(),
      }),
    )
    .default([]),
});

type SynthesisResult = z.infer<typeof synthesisSchema>;

const SYNTHESIS_SYSTEM_PROMPT = `You are Robin's behavioral-pattern analyst. You receive a batch of NEW behavioral signals (things Kevin DID or chose — purchases, shoots, film watches, health aggregates, session decisions) plus the list of EXISTING habits Robin already tracks. A habit is a HEDGED TENDENCY phrased as "tends to …" — a generalization over many actions, never a one-off.

Your job, replying ONLY with JSON matching the schema:
1. reinforcements: when a new signal is a fresh INSTANCE of an existing habit's abstract pattern, attribute it — reference the habit's id and the source event ids that evidence it. Semantic attribution is your whole purpose (the deterministic tier already did exact-name matching).
2. newHabits: propose a NEW candidate habit ONLY when several signals together reveal an abstract tendency NOT already tracked. State it as a hedged "tends to …" sentence. Report distinctTimeSpans (how many separate time periods the supporting signals span) and distinctStreams (how many different signal sources — e.g. purchases vs photos vs films). A pattern seen once, or only within one stream, is NOT a habit — do not propose it.
3. merges: if two existing habits say the same thing, fold the lower into the target by statement + id.

Hard rules:
- Phrase every habit as a tendency ("tends to buy camera gear before a planned trip"), never a certainty.
- Do NOT resurrect any pattern that looks retired/vetoed — if a proposal resembles one Robin previously dropped, omit it.
- Do NOT invent signals. Cite only event ids present in the input.
- domain must be one of: health, finance, career, relationships, preferences, creative, travel, home, life_events, identity, directives.
- patternKind must be one of: purchase, temporal, preference, workflow, consumption.
If nothing rises to a tendency, return empty arrays.`;

/** Outcome of one Tier B (LLM synthesis) pass. */
export interface BehaviorSynthesizeResult {
  /** Habits reinforced via semantic attribution. */
  reinforced: number;
  /** New soft habits created (after the §7 creation floor). */
  created: number;
  /** Proposed habits dropped by retired-suppression (§8). */
  suppressed: number;
  /** Proposed habits merged into an existing habit (embedding-dedup). */
  merged: number;
  /** Habits graduated to a `preferences` belief_candidate this pass (§8). */
  graduated: number;
  /** True when the pass skipped (engine disabled OR no LLM OR no new staged signals). */
  skipped: boolean;
}

const ZERO: BehaviorSynthesizeResult = {
  reinforced: 0,
  created: 0,
  suppressed: 0,
  merged: 0,
  graduated: 0,
  skipped: true,
};

/** Render a signal compactly for the prompt — id-tagged so the model can cite event ids. */
function renderSignal(s: BehavioralSignal): string {
  const parts = [
    `#${s.sourceEventId}`,
    `[${s.sourceKind}]`,
    `${s.action}`,
    s.object ? `"${s.object}"` : '',
    `(${s.domain}, ${s.ts})`,
  ].filter(Boolean);
  return parts.join(' ');
}

/** Render an existing habit compactly for the prompt. */
function renderHabit(h: Habit): string {
  return `id=${h.id} [${h.domain}/${h.patternKind}] "${h.statement}" (support=${h.supportCount}, streams=${h.supportStreams})`;
}

/** Coerce the model's domain/patternKind strings to the typed unions, or null if invalid. */
function coerceDomain(raw: string): PersonalDomain | null {
  return isPersonalDomain(raw) ? raw : null;
}
function coercePatternKind(raw: string): PatternKind | null {
  return PATTERN_KINDS.has(raw) ? (raw as PatternKind) : null;
}

/** True when a candidate embedding collides with any retired pattern (engine-enforced §8). */
function collidesWithRetired(
  embedding: number[],
  retired: Array<{ embedding: Float32Array }>,
): boolean {
  for (const r of retired) {
    if (cosine(embedding, r.embedding) >= RETIRED_SUPPRESS_THRESHOLD) return true;
  }
  return false;
}

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

/** Best-effort embed of a habit statement; null when no embedder / the embed failed. */
async function embedStatement(llm: LLMDispatcher, statement: string): Promise<number[] | null> {
  try {
    return await embedBody(llm, statement);
  } catch {
    return null;
  }
}

/**
 * Tier B — weekly LLM synthesis pass. Honors the `enabled` kill-switch and skips when
 * no LLM is available OR no new signals are staged. Otherwise makes ONE bounded
 * StructuredOutput call, applies reinforcements / creation-floored new habits / merges
 * with engine-enforced dedup + retired-suppression, runs the §8 graduation pass, and
 * advances the synthesize cursor.
 *
 * @param opts.enabled           Resolved `behavior.enabled` policy (default true).
 * @param opts.graduationSupport Resolved `behavior.graduationSupport` (K).
 * @param opts.graduationWeeks   Resolved `behavior.graduationWeeks` (X).
 * @param opts.now               Injectable reference time for deterministic tests.
 */
export async function runBehaviorSynthesize(
  db: RobinDb,
  llm: LLMDispatcher | null,
  opts: {
    enabled?: boolean;
    graduationSupport?: number;
    graduationWeeks?: number;
    now?: Date;
  } = {},
): Promise<BehaviorSynthesizeResult> {
  const enabled = opts.enabled ?? true;
  if (!enabled || !llm) {
    log.info(
      { enabled, hasLlm: llm != null },
      'behavior Tier B synthesis skipped (disabled or no LLM)',
    );
    return { ...ZERO };
  }

  const now = opts.now ?? new Date();
  const graduationSupport = opts.graduationSupport ?? 4;
  const graduationWeeks = opts.graduationWeeks ?? 3;

  // 1. Pull new staged signals (bounded by SIGNAL_CAP). Skip when nothing is staged.
  const cursorBefore = getSynthesizeCursor(db);
  const { signals, cursor } = selectNewSignals(db, cursorBefore, SIGNAL_CAP);
  if (signals.length === 0) {
    log.info('behavior Tier B synthesis: no new staged signals — skipping');
    return { ...ZERO };
  }
  // Overflow accounting: when we hit the cap there may be more after `cursor`. The cursor
  // advances only past the consumed rows, so the remainder is deferred (not dropped) to
  // the next run — log it so a backlog is visible (no silent caps).
  if (signals.length >= SIGNAL_CAP) {
    log.info(
      { cap: SIGNAL_CAP, cursor },
      'behavior Tier B: signal cap hit — remainder deferred to next run via cursor',
    );
  }

  // 2. Load the existing habit context: soft + graduated (the model's reinforce/merge
  //    targets) and the retired suppression set (engine-enforced, not prompt-trusted).
  const activeHabits = [...listHabits(db, 'soft'), ...listHabits(db, 'graduated')];
  const retired = listRetiredEmbeddings(db);

  // 3. ONE StructuredOutput call. Bound generation pre-call (maxTokens) and verify the
  //    realized cost against the per-run budget after.
  let parsed: SynthesisResult;
  try {
    const res = await llm.invoke('reasoning', {
      systemPrompt: SYNTHESIS_SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: [
            'NEW SIGNALS:',
            signals.map(renderSignal).join('\n') || '(none)',
            '',
            'EXISTING HABITS:',
            activeHabits.map(renderHabit).join('\n') || '(none)',
          ].join('\n'),
        },
      ],
      outputSchema: synthesisSchema,
      temperature: 0,
      maxTokens: SYNTHESIS_MAX_TOKENS,
    });

    if ((res.costUsd ?? 0) > SYNTHESIS_BUDGET_USD) {
      log.warn(
        { costUsd: res.costUsd, budget: SYNTHESIS_BUDGET_USD },
        'behavior Tier B: synthesis call exceeded per-run budget — discarding output, not advancing cursor',
      );
      return { ...ZERO, skipped: false };
    }

    parsed = parseSynthesis(res.structured, res.text);
  } catch (err) {
    // Outage / bad output: don't advance the cursor so the signals are re-processed next
    // run (mirrors the biographer's "don't lose work on an LLM failure" discipline).
    log.warn({ err: String(err) }, 'behavior Tier B: synthesis call failed — deferring signals');
    return { ...ZERO, skipped: false };
  }

  const result: BehaviorSynthesizeResult = {
    reinforced: 0,
    created: 0,
    suppressed: 0,
    merged: 0,
    graduated: 0,
    skipped: false,
  };

  const habitById = new Map(activeHabits.map((h) => [h.id, h] as const));

  // 4a. Reinforcements → bump support + recompute confidence.
  for (const r of parsed.reinforcements) {
    const habit = habitById.get(r.habitId);
    if (!habit) continue; // model cited an unknown / non-active id — ignore
    const newStreams = Math.max(habit.supportStreams, 1);
    updateHabitReinforcement(db, habit.id, {
      addEventId: r.evidenceEventIds[0],
      supportStreams: newStreams,
      at: now,
    });
    recomputeConfidenceFor(
      db,
      habit.id,
      computeConfidence({
        supportCount: habit.supportCount + 1,
        supportStreams: newStreams,
        lastReinforcedAt: now,
        contradictionCount: habit.contradictionCount,
        now,
      }),
    );
    result.reinforced++;
  }

  // 4b. New habits → §7 creation floor, then embedding dedup/suppression upsert.
  for (const nh of parsed.newHabits) {
    const statement = nh.statement?.trim();
    if (!statement) continue;
    const domain = coerceDomain(nh.domain);
    const patternKind = coercePatternKind(nh.patternKind);
    if (!domain || !patternKind) continue; // invalid taxonomy — drop

    // §7 creation floor: ≥2 distinct time-spans AND ≥2 streams, else drop (floored).
    if (nh.distinctTimeSpans < 2 || nh.distinctStreams < 2) {
      log.info({ statement }, 'behavior Tier B: new habit floored (§7 — <2 spans or <2 streams)');
      continue;
    }

    const embedding = await embedStatement(llm, statement);

    // Engine-enforced retired-suppression (§8): drop a proposal that resurrects a retired
    // pattern — checked HERE, never trusting the prompt's "don't resurrect" instruction.
    if (embedding && collidesWithRetired(embedding, retired)) {
      result.suppressed++;
      log.info({ statement }, 'behavior Tier B: new habit suppressed (matches a retired pattern)');
      continue;
    }

    // Embedding dedup: a near soft/graduated twin → reinforce it instead of inserting.
    if (embedding) {
      const near = findNearestHabitByEmbedding(db, embedding, {
        statuses: ['soft', 'graduated'],
      });
      if (near) {
        const h = near.habit;
        const newStreams = Math.max(h.supportStreams, nh.distinctStreams, INITIAL_SUPPORT_STREAMS);
        updateHabitReinforcement(db, h.id, {
          addEventId: nh.evidenceEventIds[0],
          supportStreams: newStreams,
          at: now,
        });
        recomputeConfidenceFor(
          db,
          h.id,
          computeConfidence({
            supportCount: h.supportCount + 1,
            supportStreams: newStreams,
            lastReinforcedAt: now,
            contradictionCount: h.contradictionCount,
            now,
          }),
        );
        result.merged++;
        continue;
      }
    }

    // No twin, not retired → insert a fresh soft habit with an engine-owned confidence.
    const supportStreams = Math.max(nh.distinctStreams, INITIAL_SUPPORT_STREAMS);
    const confidence = computeConfidence({
      supportCount: INITIAL_SUPPORT_COUNT,
      supportStreams,
      lastReinforcedAt: now,
      contradictionCount: 0,
      now,
    });
    insertHabit(db, {
      statement,
      domain,
      patternKind,
      confidence,
      supportCount: INITIAL_SUPPORT_COUNT,
      supportStreams,
      evidenceEventIds: nh.evidenceEventIds,
      evidenceSummary: nh.evidenceSummary,
      embedding: embedding ?? null,
      firstSeen: now,
      lastSeen: now,
      lastReinforced: now,
    });
    result.created++;
  }

  // 4c. Merges → fold the lower habit into the target (bump the target's support).
  for (const m of parsed.merges) {
    const target = habitById.get(m.intoHabitId);
    if (!target) continue;
    const from = activeHabits.find(
      (h) => h.id !== target.id && h.statement.trim() === m.fromStatement?.trim(),
    );
    if (!from) continue;
    // Retire the lower, credit the target with the fold (support + recency).
    const newStreams = Math.max(target.supportStreams, from.supportStreams);
    updateHabitReinforcement(db, target.id, { supportStreams: newStreams, at: now });
    recomputeConfidenceFor(
      db,
      target.id,
      computeConfidence({
        supportCount: target.supportCount + 1,
        supportStreams: newStreams,
        lastReinforcedAt: now,
        contradictionCount: target.contradictionCount,
        now,
      }),
    );
    setHabitStatus(db, from.id, 'retired');
    result.merged++;
  }

  // 5. Graduation pass (§8): every soft habit that clears the gate AND is not in a
  //    non-graduating sensitive domain emits a `preferences` belief_candidate and flips
  //    to `graduated`. Re-read soft habits so just-created/just-reinforced rows are seen.
  for (const habit of listHabits(db, 'soft')) {
    if (NON_GRADUATING_DOMAINS.has(habit.domain)) continue;
    if (!meetsGraduationGate(habit, { graduationSupport, graduationWeeks, now })) continue;
    const emitted = await graduateHabit(db, habit);
    if (!emitted) continue; // candidate filtered — leave soft
    setHabitStatus(db, habit.id, 'graduated', emitted.beliefCandidateId);
    result.graduated++;
  }

  // 6. Advance + persist the synthesize cursor (only past the consumed rows).
  setSynthesizeCursor(db, cursor);

  log.info({ ...result, cursor }, 'behavior Tier B synthesis complete');
  return result;
}

/**
 * Validate the model's output into the synthesis schema. Prefers the native
 * StructuredOutput object (`res.structured`); falls back to parsing `res.text` as JSON
 * (the biographer's manual-parse path) so the engine works with providers that don't
 * return structured output. A parse/schema failure yields an all-empty result (the pass
 * makes no writes but still advances the cursor — the signals were genuinely seen).
 */
function parseSynthesis(structured: unknown, text: string): SynthesisResult {
  if (structured !== undefined && structured !== null) {
    const r = synthesisSchema.safeParse(structured);
    if (r.success) return r.data;
  }
  const jsonText = (text ?? '')
    .trim()
    .replace(/^```(?:json)?/, '')
    .replace(/```$/, '')
    .trim();
  if (jsonText) {
    try {
      const r = synthesisSchema.safeParse(JSON.parse(jsonText));
      if (r.success) return r.data;
    } catch {
      // fall through to empty
    }
  }
  return { reinforcements: [], newHabits: [], merges: [] };
}
