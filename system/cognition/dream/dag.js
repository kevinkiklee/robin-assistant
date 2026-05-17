// dag.js — Dependency graph for the dream pipeline. Spec §1.3.
//
// Keys are camelCase and MUST match the `summary.<key>` shape produced by
// today's pipeline.js (and consumed by dispatcher-tick.js,
// show-step-health.js, run-dream.js, dream-full-cycle.test.js). The graph is
// validated at boot by gate G20 in verify-design-assumptions.js (Phase 9).

export const DREAM_DAG_DEPS = {
  knowledge: [],
  patterns: [],
  reflection: [],
  profile: [],
  arcs: [],
  commStyle: [],
  scopeCleanup: ['knowledge'], // §1.2 — derived_from edges seed scope-cleanup's promote pass
  calibration: ['commStyle'], // §1.2 — persona MERGE serial within a dream run
  // §1.2 — content_hash + delete-then-archive.
  compaction: ['knowledge', 'scopeCleanup'],
  // v2 self-improvement steps (4 real, 1 stub — selfImprovementRollup pending Wave 3 follow-up).
  // Gated on runtime:self-improvement-v2. Layer labels reflect topological order under DREAM_DAG_DEPS.
  outcomeGrading: [], // L1, Haiku — fills score on ungraded task_outcome rows
  playbookSynthesis: ['outcomeGrading', 'reflection'], // L2, Opus, K=5/night cap
  calibrationBucket: [], // L1, pure math — sole writer of confidence_band memos
  predictionTaxonomy: [], // L1, weekly — clusters kind='other' predictions
  selfImprovementRollup: ['outcomeGrading', 'playbookSynthesis', 'calibrationBucket', 'predictionTaxonomy'], // L3, writes v2 metrics
};
