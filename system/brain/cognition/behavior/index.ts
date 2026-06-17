/**
 * Behavioral Habit Inference (Phase 2) — engine entry points (barrel).
 * Design ref: docs/design/2026-06-17-behavioral-habit-inference-design.md §5.
 *
 * The engine splits along the same line Robin already splits deterministic `dream`
 * from LLM `dream-synthesis`:
 *  - Tier A (`runBehaviorReinforce`, tier-a.ts): nightly, deterministic, NO LLM.
 *  - Tier B (`runBehaviorSynthesize`, tier-b.ts): weekly, LLM StructuredOutput synthesis.
 *
 * Each tier lives in its own module so they can be developed independently; this barrel
 * is the stable import surface for job registration.
 */

export { type BehaviorReinforceResult, runBehaviorReinforce } from './tier-a.ts';
export { type BehaviorSynthesizeResult, runBehaviorSynthesize } from './tier-b.ts';
export * from './types.ts';
