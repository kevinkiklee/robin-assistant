// step-registry.js — name → (ctx) => Promise<result> map for the dream DAG.
// Spec §4. Each thunk forwards ctx into the existing step function with the
// same argument shape used by today's serial pipeline.
//
// IMPORTANT: keys are camelCase and MUST match the summary contract. See the
// header in dag.js for why.

import { dreamStepArcs } from './step-arcs.js';
import { dreamStepCalibration } from './step-calibration.js';
import { dreamStepCommStyle } from './step-comm-style.js';
import { dreamStepCompaction } from './step-compaction.js';
import { dreamStepConfidenceRecompute } from './step-confidence-recompute.js';
import { dreamStepKnowledge } from './step-knowledge.js';
import { dreamStepPatterns } from './step-patterns.js';
import { dreamStepProfile } from './step-profile.js';
import { dreamStepReflection } from './step-reflection.js';
import { dreamStepScopeCleanup } from './step-scope-cleanup.js';

export const byName = {
  knowledge: ({ db, host, embedder, opts }) =>
    dreamStepKnowledge(db, host, embedder, opts?.knowledge),
  patterns: ({ db, host }) => dreamStepPatterns(db, host),
  reflection: ({ db, host, opts }) => dreamStepReflection(db, host, opts?.reflection),
  confidence: ({ db }) => dreamStepConfidenceRecompute(db),
  profile: ({ db, host, opts }) => dreamStepProfile(db, host, opts?.profile),
  arcs: ({ db, opts }) => dreamStepArcs(db, opts?.arcs),
  commStyle: ({ db, host }) => dreamStepCommStyle(db, host),
  calibration: ({ db }) => dreamStepCalibration(db),
  scopeCleanup: ({ db, host, opts }) => dreamStepScopeCleanup(db, host, opts?.scopeCleanup),
  compaction: ({ db }) => dreamStepCompaction(db),
};
