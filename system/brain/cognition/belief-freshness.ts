/**
 * P2 — Nightly belief freshness pass.
 *
 * Scans the live belief head set, identifies staleness per provenance-class
 * TTL, and either re-queries a registered resolver (bounded by maxRequeries)
 * or raises an idempotent `belief.stale` flag event for human/integration
 * follow-up.
 *
 * Design notes:
 * - Resolver registry is keyed by topic PREFIX so integrations wire up their
 *   own refresh logic without coupling the core framework to any integration.
 * - The scan/flag/decay path is fully active regardless of whether any resolver
 *   is registered — this seam is intentional, not dead code.
 * - One bad belief head cannot sink the whole run: each head is processed
 *   inside a try/catch.
 */

import type { LLMDispatcher } from '../llm/dispatcher.ts';
import type { BeliefRecord } from '../memory/belief.ts';
import { believe, canonicalizeTopic, normalizeTopic, recallBelief } from '../memory/belief.ts';
import type { RobinDb } from '../memory/db.ts';
import { ingest } from '../memory/ingest.ts';
import { ageDaysFrom, FRESHNESS_TTL_DAYS, isStale } from '../memory/provenance.ts';

// Re-export so callers can import the type from this module.
export type { BeliefRecord };

/** A function that attempts to re-verify a stale belief. Return non-null with
 *  optional updated `claim` and/or `confidence` on success; return null when
 *  the belief cannot be re-verified at this time (triggers fallback flagging). */
export type BeliefResolver = (
  head: BeliefRecord,
) => Promise<{ claim?: string; confidence?: number } | null>;

/** Module-level resolver registry: topic prefix → resolver fn. */
const resolverRegistry = new Map<string, BeliefResolver>();

/** Register a resolver for beliefs whose topic starts with `topicPrefix`. */
export function registerBeliefResolver(topicPrefix: string, fn: BeliefResolver): void {
  resolverRegistry.set(topicPrefix, fn);
}

/** Clear all registered resolvers. Intended for test isolation. */
export function clearBeliefResolvers(): void {
  resolverRegistry.clear();
}

/** Find the resolver whose registered prefix is a prefix of `topic`. */
function findResolver(topic: string): BeliefResolver | undefined {
  for (const [prefix, fn] of resolverRegistry) {
    if (topic.startsWith(prefix)) return fn;
  }
  return undefined;
}

export interface BeliefFreshnessResult {
  /** Total live (non-retracted) belief heads considered. */
  scanned: number;
  /** Heads that were stale per their provenance-class TTL. */
  stale: number;
  /** Stale heads flagged with a `belief.stale` event (no resolver, cap reached, or null refresh). */
  flagged: number;
  /** Stale heads successfully re-verified via a resolver. */
  requeried: number;
}

/**
 * Build a canonical-topic → correction-count map in ONE query per freshness
 * pass (not one per head). Belief heads are now stored under CANONICAL slugs
 * (spec §C1), but `corrections.topic` rows may carry non-canonical strings
 * (negated/modified variants, legacy data). So we load the DISTINCT correction
 * topics once, canonicalize each, and fold their counts onto the canonical key.
 * A stale head's correction pressure is then a single map lookup keyed by its
 * (already-canonical) topic. The corrections table is small (<100 rows), so the
 * one-pass scan is cheap and deterministic.
 */
function buildCorrectionCounts(db: RobinDb): Map<string, number> {
  const rows = db
    .prepare(`SELECT topic, COUNT(*) AS n FROM corrections WHERE topic IS NOT NULL GROUP BY topic`)
    .all() as Array<{ topic: string; n: number }>;
  const counts = new Map<string, number>();
  for (const { topic, n } of rows) {
    const canonical = canonicalizeTopic(normalizeTopic(topic));
    if (!canonical) continue;
    counts.set(canonical, (counts.get(canonical) ?? 0) + n);
  }
  return counts;
}

/**
 * Risk score for a stale head (spec §C2). Three components, each in 0..1, summed:
 * - **uncertainty** = 1 − stored confidence (null confidence → treated as 0.5).
 * - **over-age** = how far past the TTL window the head has drifted, normalized
 *   against 4× its class TTL and clamped to 1. Infinite-TTL classes (first-party)
 *   never reach this path, but guard anyway → 0.
 * - **correction pressure** = corrections recorded on the topic, capped at 3 and
 *   scaled to 0..1, looked up from the pre-built per-pass map (no per-head query).
 *
 * Higher = riskier = more deserving of a scarce re-query slot. Deterministic; no
 * tunables in config. Never throws on null confidence or a topic with no
 * corrections (map lookup defaults to 0).
 */
function riskScore(
  head: BeliefRecord,
  ageDays: number,
  correctionCounts: Map<string, number>,
): number {
  const uncertainty = 1 - (head.confidence ?? 0.5);
  const ttl = FRESHNESS_TTL_DAYS[head.provenance];
  const overAge = Number.isFinite(ttl) ? Math.min(ageDays / (4 * ttl), 1) : 0;
  const corrections = correctionCounts.get(head.topic) ?? 0;
  return uncertainty + overAge + Math.min(corrections, 3) / 3;
}

/**
 * Run the nightly belief freshness pass.
 *
 * Two phases (spec §C2):
 * 1. **Collect** — scan every live belief head, compute age from `verifiedAt`
 *    (or `ts` as fallback), and gather the stale ones. Non-stale heads are
 *    skipped. `scanned`/`stale` accounting happens here.
 * 2. **Act** — score every stale head (uncertainty + over-age + correction
 *    history), then spend the scarce `maxRequeries` re-query budget on the
 *    HIGHEST-risk resolver-bearing heads first (not the first N enumerated).
 *    Each acted-on head:
 *    - Resolver returns a refresh → write a re-confirmation belief superseding
 *      the current head; requeried++.
 *    - Resolver returns null, no resolver exists, or the cap is reached → raise
 *      an idempotent `belief.stale` flag event; flagged++.
 *
 * Same `maxRequeries` spend as the prior first-N selection — same cost, better
 * targets. Per-head processing stays inside its own try/catch so one bad head
 * cannot sink the run.
 */
export async function runBeliefFreshness(
  db: RobinDb,
  llm: LLMDispatcher | null,
  opts?: { now?: Date; maxRequeries?: number },
): Promise<BeliefFreshnessResult> {
  const now = opts?.now ?? new Date();
  const maxRequeries = opts?.maxRequeries ?? 10;
  const nowMs = now.getTime();
  const todayDate = now.toISOString().slice(0, 10); // YYYY-MM-DD

  const result: BeliefFreshnessResult = {
    scanned: 0,
    stale: 0,
    flagged: 0,
    requeried: 0,
  };

  // Pull all belief heads (recallBelief with no topic returns the array of heads).
  const raw = recallBelief(db);
  // Normalise: recallBelief returns BeliefRecord | BeliefRecord[] | null depending on opts.
  const heads: BeliefRecord[] = Array.isArray(raw) ? raw : raw ? [raw] : [];

  // --- Phase 1: collect every stale head (enumerate order, unchanged). ---
  const staleHeads: Array<{ head: BeliefRecord; age: number }> = [];
  for (const head of heads) {
    // Skip retracted beliefs — they are intentionally invalidated.
    if (head.retracted) continue;

    result.scanned++;

    const age = ageDaysFrom(head.verifiedAt ?? head.ts, nowMs);

    if (!isStale(age, head.provenance)) continue;

    result.stale++;
    staleHeads.push({ head, age });
  }

  // --- Phase 2: score, then spend the re-query budget on the riskiest heads. ---
  // One corrections query per pass (not per head); folds non-canonical correction
  // topics onto canonical keys so a head's score sees its full correction history.
  const correctionCounts = buildCorrectionCounts(db);

  // Partition into resolver-bearing (compete for the scarce re-query slots) and
  // resolver-less (always fall straight to flagging). Sort the resolver-bearing
  // by risk descending so the highest-risk stale heads claim the slots first;
  // resolver-less heads keep enumerate order (their order is immaterial — every
  // one is flagged). Stable scoring: each head scored exactly once.
  const withResolver: Array<{ head: BeliefRecord; age: number; resolver: BeliefResolver }> = [];
  const withoutResolver: Array<{ head: BeliefRecord; age: number }> = [];
  for (const entry of staleHeads) {
    const resolver = findResolver(entry.head.topic);
    if (resolver) withResolver.push({ ...entry, resolver });
    else withoutResolver.push(entry);
  }
  withResolver.sort(
    (a, b) =>
      riskScore(b.head, b.age, correctionCounts) - riskScore(a.head, a.age, correctionCounts),
  );

  // Process resolver-bearing heads in risk order, then resolver-less heads. The
  // per-head body below is unchanged from the prior single-pass version; only the
  // iteration order and slot allocation differ.
  for (const { head, age, resolver } of [
    ...withResolver,
    ...withoutResolver.map((e) => ({ ...e, resolver: undefined as BeliefResolver | undefined })),
  ]) {
    // Try resolver path first (bounded by the re-query cap).
    if (resolver && result.requeried < maxRequeries) {
      try {
        const refresh = await resolver(head);
        if (refresh !== null) {
          // Write a re-confirmation superseding the current head.
          believe(db, llm, {
            topic: head.topic,
            claim: refresh.claim ?? head.claim,
            confidence: refresh.confidence ?? head.confidence ?? undefined,
            provenance: head.provenance,
            verifiedAt: now.toISOString(),
            supersedes: head.eventId,
          });
          result.requeried++;
          continue; // do NOT also flag
        }
      } catch {
        // Resolver threw — fall through to flagging.
      }
    }

    // Fallback: raise an idempotent belief.stale flag event.
    try {
      const externalId = `stale:${head.topic}:${todayDate}`;

      const alreadyFlagged = db
        .prepare(
          `SELECT 1 FROM events
           WHERE kind = 'belief.stale'
             AND json_extract(payload, '$.external_id') = ?
           LIMIT 1`,
        )
        .get(externalId);

      if (!alreadyFlagged) {
        ingest(db, llm, {
          kind: 'belief.stale',
          source: 'dream',
          content: `${head.topic} belief unverified for ${Math.round(age)}d`,
          payload: {
            topic: head.topic,
            eventId: head.eventId,
            ageDays: Math.round(age),
            provenance: head.provenance,
            external_id: externalId,
          },
        });
        result.flagged++;
      }
    } catch {
      // Don't let a flag-write failure sink the rest of the run.
    }
  }

  return result;
}
