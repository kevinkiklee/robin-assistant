import type { RobinDb } from '../../memory/db.ts';
import type { PersonalDomain } from '../../memory/domains.ts';

/**
 * Domain Scouts (value-loops W4) — core types.
 * Design ref: docs/design/2026-08-10-value-loops-plan-3-scouts.md (Task 1);
 * spec docs/design/2026-08-10-value-loops-redesign.md §6.
 *
 * A scout is a weekly per-domain pass over ALREADY-FLOWING event streams: a
 * deterministic SQL digest, ONE structured `'reasoning'` call over it, and every
 * candidate routed through `applyRecommendGate` — no side doors into the
 * recommendations ledger.
 */

export interface ScoutSource {
  /** events.source value this scout reads (e.g. 'lunch_money'). */
  source: string;
  /** Freshness window: MAX(ts) older than this → source unusable this pass. */
  maxAgeDays: number;
}

export interface ScoutConfig {
  /** Short id used in job names, logs, and policy keys (e.g. 'finance'). */
  id: string;
  domain: PersonalDomain;
  sources: ScoutSource[];
  /**
   * Deterministic digest over FRESH sources only (staleSources already removed).
   * Returns compact text for the LLM, or null when there is nothing worth scanning
   * (→ the pass skips). Pure SQL over events — no I/O beyond the db, no LLM.
   */
  digest: (db: RobinDb, now: Date, freshSources: string[]) => string | null;
  /** Domain-specific instruction appended to the shared scout prompt. */
  guidance: string;
}

export interface ScoutRunResult {
  scout: string;
  skipped: 'disabled' | 'all-stale' | 'empty-digest' | 'no-llm' | null;
  staleSources: string[];
  candidates: number; // parsed from the LLM
  dropped: number; // below MIN_SCAN_CONFIDENCE
  inserted: number;
  duplicates: number;
  superseded: number;
}
