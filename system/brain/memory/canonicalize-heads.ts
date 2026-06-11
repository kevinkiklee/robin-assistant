import { levenshtein } from '../../lib/levenshtein.ts';
import type { LLMDispatcher } from '../llm/dispatcher.ts';
import { type BeliefRecord, canonicalizeTopic, recallBelief } from './belief.ts';
import type { RobinDb } from './db.ts';
import { ingest } from './ingest.ts';

export interface CanonicalizeDecision {
  canonical: string;
  topics: string[];
  decision: 'merged' | 'skipped-dissimilar';
  winnerEventId?: number;
}

export interface CanonicalizeResult {
  groups: number;
  merged: number;
  skipped: number;
  decisions: CanonicalizeDecision[];
}

const MERGE_MAX_DIST = 0.4; // same gate as believe()'s cross-slug threshold

/**
 * One-time sweep (spec §C1): group live belief heads by canonical slug; for each
 * multi-head group whose claims are pairwise similar, collapse all heads onto one
 * live head under the canonical topic. Dissimilar groups are left alone (false
 * merges are worse than duplicates). Every decision — merge or skip — is recorded
 * as a `belief.canonicalize` audit event when apply:true. Safe to re-run: the
 * superseding writes carry `canonicalize:`-prefixed external_ids so ingest()
 * upserts rather than appends on second pass (idempotent across dates).
 */
export function canonicalizeBeliefHeads(
  db: RobinDb,
  llm: LLMDispatcher | null,
  opts: { apply?: boolean } = {},
): CanonicalizeResult {
  // Enumerate all live belief heads — override the default limit of 50.
  const raw = recallBelief(db, { limit: 10_000 });
  const heads: BeliefRecord[] = Array.isArray(raw) ? raw : raw ? [raw] : [];

  // Group heads by their canonical slug.
  const byCanonical = new Map<string, BeliefRecord[]>();
  for (const h of heads) {
    const c = canonicalizeTopic(h.topic);
    const list = byCanonical.get(c) ?? [];
    list.push(h);
    byCanonical.set(c, list);
  }

  const result: CanonicalizeResult = { groups: 0, merged: 0, skipped: 0, decisions: [] };

  for (const [canonical, group] of byCanonical) {
    if (group.length < 2) continue;
    result.groups++;

    // Sort newest-first by ts, then by eventId desc as a tiebreaker for same-second inserts.
    group.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : b.eventId - a.eventId));
    // The winner is the most recent head — its claim becomes the canonical truth.
    const winner = group[0];

    // All non-winner claims must be similar to the winner's claim.
    const allSimilar = group.slice(1).every((h) => {
      const longer = Math.max(winner.claim.length, h.claim.length);
      if (longer === 0) return false;
      return levenshtein(winner.claim, h.claim) / longer < MERGE_MAX_DIST;
    });

    const decision: CanonicalizeDecision = {
      canonical,
      topics: group.map((h) => h.topic),
      decision: allSimilar ? 'merged' : 'skipped-dissimilar',
      ...(allSimilar ? { winnerEventId: winner.eventId } : {}),
    };
    result.decisions.push(decision);

    if (!allSimilar) {
      result.skipped++;
      if (opts.apply) {
        // Audit event for skipped groups (spec: log every merge decision).
        ingest(db, llm, {
          kind: 'belief.canonicalize',
          source: 'maintenance',
          content: `${decision.decision}: [${decision.topics.join(', ')}] → ${canonical}`,
          payload: {
            ...decision,
            external_id: `canonicalize:skip:${canonical}`,
          },
        });
      }
    } else if (opts.apply) {
      // Step 1: Ensure the canonical topic has a live head with the winner's claim.
      // If the winner is already under the canonical topic, it's already there.
      // If not, write a new belief.update under the canonical topic.
      if (winner.topic !== canonical) {
        ingest(db, llm, {
          kind: 'belief.update',
          source: 'belief',
          content: winner.claim,
          payload: {
            topic: canonical,
            supersedes: null,
            confidence: winner.confidence ?? null,
            sources: winner.sources ?? [],
            retracted: false,
            provenance: winner.provenance ?? 'unknown',
            verified_at: winner.verifiedAt ?? new Date().toISOString(),
            external_id: `canonicalize:promote:${canonical}:${winner.eventId}`,
          },
        });
      }

      // Step 2: Retract every non-canonical head (all heads whose topic !== canonical).
      // Writing a retraction under the loser's own topic ensures:
      //   - The ROW_NUMBER() partition for that topic gets a newer rn=1 row
      //   - That rn=1 row is retracted, so the enumerate query filters it out
      //   - The external_id is stable across dates → idempotent re-runs
      for (const h of group) {
        if (h.topic === canonical) continue; // leave the canonical head untouched
        ingest(db, llm, {
          kind: 'belief.update',
          source: 'belief',
          content: winner.claim,
          payload: {
            topic: h.topic,
            supersedes: h.eventId,
            confidence: winner.confidence ?? null,
            sources: winner.sources ?? [],
            retracted: true,
            provenance: winner.provenance ?? 'unknown',
            verified_at: winner.verifiedAt ?? new Date().toISOString(),
            external_id: `canonicalize:${h.topic}:${h.eventId}`,
          },
        });
      }

      result.merged++;

      // Audit event for merged group.
      ingest(db, llm, {
        kind: 'belief.canonicalize',
        source: 'maintenance',
        content: `${decision.decision}: [${decision.topics.join(', ')}] → ${canonical}`,
        payload: {
          ...decision,
          external_id: `canonicalize:${canonical}:${winner.eventId}`,
        },
      });
    } else {
      // dry-run: count what WOULD merge (no writes).
      result.merged++;
    }
  }

  return result;
}
