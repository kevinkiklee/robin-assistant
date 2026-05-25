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
import { believe, recallBelief } from '../memory/belief.ts';
import type { RobinDb } from '../memory/db.ts';
import { ingest } from '../memory/ingest.ts';
import { ageDaysFrom, isStale } from '../memory/provenance.ts';

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
 * Run the nightly belief freshness pass.
 *
 * For each live belief head:
 * 1. Compute age from `verifiedAt` (or `ts` as fallback).
 * 2. Skip non-stale heads.
 * 3. For stale heads, try a registered resolver first (bounded by maxRequeries).
 *    - Resolver returns a refresh → write a re-confirmation belief superseding
 *      the current head; requeried++.
 *    - Resolver returns null, no resolver exists, or cap is reached → raise an
 *      idempotent `belief.stale` flag event; flagged++.
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

  for (const head of heads) {
    // Skip retracted beliefs — they are intentionally invalidated.
    if (head.retracted) continue;

    result.scanned++;

    const age = ageDaysFrom(head.verifiedAt ?? head.ts, nowMs);

    if (!isStale(age, head.provenance)) continue;

    result.stale++;

    // Try resolver path first.
    const resolver = findResolver(head.topic);

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
