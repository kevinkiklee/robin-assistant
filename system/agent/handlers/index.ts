// Importing each handler module triggers its `register()` side-effect, so a
// single import of this barrel populates the REGISTRY with all handlers A–L.
import './a-self-improvement.ts';
import './b-research.ts';
import './c-integration.ts';
import './d-kb-curation.ts';
import './e-belief-reconcile.ts';
import './f-prediction-calibrate.ts';
import './g-gap-fill.ts';
import './h-dream-enrich.ts';
import './i-life-executor.ts';
import './j-integration-author.ts';
import './k-health-remediate.ts';
import './l-daily-brief.ts';

export type { HandlerCtx, HandlerDef } from './types.ts';
export { REGISTRY, register } from './types.ts';
