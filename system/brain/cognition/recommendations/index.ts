/**
 * Recommendation→Action Loop (Phase 1) — subsystem barrel.
 * Design ref: docs/design/2026-06-17-recommendation-loop-design.md.
 */
export {
  type RecommendationLinkerOptions,
  type RecommendationLinkerResult,
  runRecommendationLinker,
} from './linker.ts';
export { type RecommendationScanResult, runRecommendationScan } from './scan.ts';
export {
  expireRecommendation,
  getRecommendation,
  type InsertRecommendationInput,
  insertRecommendation,
  listOpenRecommendations,
  listRecommendations,
  type ResolveRecommendationInput,
  resolveRecommendation,
  subjectMatches,
} from './store.ts';
export type {
  Recommendation,
  RecommendationOutcome,
  RecommendationStatus,
  Verdict,
} from './types.ts';
