/**
 * Recommendation→Action Loop (Phase 1) — subsystem barrel.
 * Design ref: docs/design/2026-06-17-recommendation-loop-design.md.
 */
export {
  applyRecommendGate,
  DEFAULT_SESSION_DAILY_CAP,
  MIN_SCAN_CONFIDENCE,
  type RecommendGateOptions,
  type RecommendGateResult,
  SessionRecCounter,
} from './gate.ts';
export {
  type RecommendationLinkerOptions,
  type RecommendationLinkerResult,
  runRecommendationLinker,
} from './linker.ts';
export {
  type LlmMatchOptions,
  type LlmMatchResult,
  runRecommendationLlmMatch,
} from './llm-match.ts';
export { distinctiveTokens, subjectMentionedIn } from './match-text.ts';
export {
  formatLastCallOverflow,
  lastCallEligible,
  lastCallOverflowCount,
  rankOpenLoops,
} from './rank.ts';
export { type RecommendationScanResult, runRecommendationScan } from './scan.ts';
export {
  expireRecommendation,
  getRecommendation,
  HOLD_VERDICTS,
  holdRecommendation,
  type InsertRecommendationInput,
  insertRecommendation,
  isHoldVerdict,
  listOpenRecommendations,
  listRecommendations,
  type ResolveRecommendationInput,
  resolveRecommendation,
  subjectMatches,
  subjectsOverlap,
} from './store.ts';
export type {
  Recommendation,
  RecommendationOutcome,
  RecommendationStatus,
  Verdict,
} from './types.ts';
