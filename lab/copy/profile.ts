// lab/copy/profile.ts
//
// Which dream steps a lab copy runs, and the biographer options it uses.
import type { RunBiographerOptions } from '../../system/brain/cognition/biographer.ts';
import { ALL_DREAM_STEPS, type DreamStep } from '../../system/brain/cognition/dream.ts';

/** Steps that neither read nor write beliefs, candidates, entities, corrections or docs (audited in profile.test.ts). */
export const EXCLUDED_STEPS: readonly DreamStep[] = [
  'predictions',
  'metrics',
  'journal',
  'digest',
  'depth',
];

/** Excluded only in template mode (Ruling 6): topic hygiene asks the LLM to judge topic merges. */
export const TEMPLATE_EXCLUDED_STEPS: readonly DreamStep[] = ['topics'];

export function labSteps(mode: 'template' | 'config'): ReadonlySet<DreamStep> {
  const drop = new Set<DreamStep>([
    ...EXCLUDED_STEPS,
    ...(mode === 'template' ? TEMPLATE_EXCLUDED_STEPS : []),
  ]);
  return new Set(ALL_DREAM_STEPS.filter((s) => !drop.has(s)));
}

/** Production biographer options (cognition-runner-entry.ts) minus tickDeadlineMs (Ruling 4). */
export const BIOGRAPHER_OPTS: Readonly<RunBiographerOptions> = Object.freeze({
  maxChunksPerTick: 10,
  batchChunks: 5,
  skipToolChunks: true,
  draftClaims: true,
  domainGating: true,
});
