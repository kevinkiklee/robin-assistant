import { levenshtein } from '../../lib/levenshtein.ts';
import type { LLMDispatcher } from '../llm/dispatcher.ts';
import { isLowQualityClaim } from './belief-quality.ts';
import type { RobinDb } from './db.ts';
import { ingest } from './ingest.ts';
import type { ProvenanceClass } from './provenance.ts';

const BELIEF_KIND = 'belief.update';
const BELIEF_SOURCE = 'belief';

/** Cross-slug merge gate (spec §C1): claims must be textually similar before a
 *  canonicalization-driven supersession is allowed. Looser than the candidate-
 *  merge 0.2 because opposing claims differ by a negation word and the slug
 *  match already established same-fact intent. */
const CANONICAL_MERGE_MAX_DIST = 0.4;

function claimsSimilar(a: string, b: string): boolean {
  const longer = Math.max(a.length, b.length);
  if (longer === 0) return false;
  if (Math.abs(a.length - b.length) / longer >= CANONICAL_MERGE_MAX_DIST) return false; // cheap short-circuit
  return levenshtein(a, b) / longer < CANONICAL_MERGE_MAX_DIST;
}

export interface BelieveInput {
  topic: string;
  claim: string;
  supersedes?: number;
  confidence?: number;
  sources?: number[];
  retracted?: boolean;
  /** provenance class of the evidence; defaults to 'unknown'. */
  provenance?: ProvenanceClass;
  /** ISO timestamp this claim was last confirmed true; defaults to now. */
  verifiedAt?: string;
  /** local date YYYY-MM-DD for idempotency scoping; defaults to today (local). */
  date?: string;
}

export interface BelieveResult {
  eventId: number;
  topic: string;
  supersededEventId: number | null;
  /** Set (with eventId = -1, no row written) when the claim was rejected as a
   *  dev/Robin-internals artifact. See `isLowQualityClaim`. */
  blocked?: 'dev-artifact';
}

export interface BeliefRecord {
  eventId: number;
  topic: string;
  claim: string;
  confidence: number | null;
  retracted: boolean;
  supersedes: number | null;
  ts: string;
  /** provenance class of the evidence ('unknown' for pre-spine beliefs). */
  provenance: ProvenanceClass;
  /** ISO timestamp this claim was last confirmed true (null if unrecorded). */
  verifiedAt: string | null;
  /** source event ids backing this claim. */
  sources: number[];
}

export interface RecallBeliefOptions {
  topic?: string;
  history?: boolean;
  limit?: number;
}

/**
 * Canonicalize a belief topic slug. Collapses style fragmentation — dots,
 * underscores, whitespace, mixed case, and stray punctuation all converge to one
 * kebab-case form — so `medications.ramelteon`, `Medications_Ramelteon`, and
 * `medications ramelteon` become the single topic `medications-ramelteon`. This
 * does NOT merge semantically-distinct slugs (`birding-location` vs
 * `birding-interest`) — that requires judgment, not normalization.
 */
export function normalizeTopic(topic: string): string {
  return topic
    .trim()
    .toLowerCase()
    .replace(/[._\s]+/g, '-') // dots, underscores, whitespace → hyphen
    .replace(/[^a-z0-9-]/g, '') // strip anything not alphanumeric or hyphen
    .replace(/-+/g, '-') // collapse repeated hyphens
    .replace(/^-+|-+$/g, ''); // trim leading/trailing hyphens
}

/** Tokens that negate a claim without changing WHICH fact it is about. Stripping
 *  them is intentional (spec §C1): opposing claims about one fact belong on one
 *  head's supersession chain. */
const NEGATION_TOKENS = new Set([
  'no',
  'not',
  'never',
  'non',
  'isnt',
  'doesnt',
  'dont',
  'without',
  'false',
  'denied',
]);
/** Style/meta tokens that fragment slugs without identifying a different fact. */
const MODIFIER_TOKENS = new Set([
  'claim',
  'claims',
  'status',
  'update',
  'updated',
  'current',
  'currently',
  'latest',
  'new',
  'recent',
  'info',
  'fact',
  'belief',
  'kevin',
  'kevins',
  'my',
]);

/**
 * Canonicalize an already-normalizeTopic'd slug down to its domain fact (spec
 * §C1): strip negation + modifier tokens so "no-aerospace-internship",
 * "aerospace-internship-claim" and "aerospace-internship" all key one head.
 * Deterministic, order-preserving, idempotent. Falls back to the input when
 * stripping would leave nothing — a slug must never canonicalize to ''.
 */
export function canonicalizeTopic(normalized: string): string {
  const kept = normalized
    .split('-')
    .filter((t) => t.length > 0 && !NEGATION_TOKENS.has(t) && !MODIFIER_TOKENS.has(t));
  if (kept.length === 0) return normalized;
  return kept.join('-');
}

function localDate(d = new Date()): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

interface RawRow {
  eventId: number;
  ts: string;
  topic: string;
  confidence: number | null;
  retracted: number | null;
  supersedes: number | null;
  claim: string | null;
  provenance: string | null;
  verified_at: string | null;
  sources: string | null;
}

/** Parse the payload's `sources` JSON text into a number[] (tolerant of nulls/garbage). */
function parseSources(raw: string | null): number[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((n): n is number => typeof n === 'number') : [];
  } catch {
    return [];
  }
}

function mapRow(r: RawRow): BeliefRecord {
  return {
    eventId: r.eventId,
    topic: r.topic,
    claim: r.claim ?? '',
    confidence: r.confidence,
    retracted: r.retracted === 1,
    supersedes: r.supersedes,
    ts: r.ts,
    provenance: (r.provenance as ProvenanceClass | null) ?? 'unknown',
    verifiedAt: r.verified_at,
    sources: parseSources(r.sources),
  };
}

export function believe(
  db: RobinDb,
  llm: LLMDispatcher | null,
  input: BelieveInput,
): BelieveResult {
  const normalized = normalizeTopic(input.topic);
  if (!normalized) throw new Error('believe: topic required');
  if (!input.claim?.trim()) throw new Error('believe: claim required');
  const canonical = canonicalizeTopic(normalized);
  // The stored topic defaults to the canonical slug; the cross-slug gate below
  // may revert it to the plain-normalized form when an implicit merge is refused.
  let topic = canonical;
  // Dev-artifact backstop for the DIRECT write path (daily-brief / dream
  // synthesis, MCP `believe` tool). The candidate pipeline filters at draft +
  // promote time; direct `believe()` calls bypassed it entirely, which is how
  // beliefs about Robin's own internals (integration counts, belief-topic churn,
  // a SurrealDB transport experiment) got minted. A *retraction* is always
  // allowed through — it removes machinery noise, never adds it — so existing
  // dev-artifact beliefs stay retractable.
  if (input.retracted !== true && isLowQualityClaim(topic, input.claim)) {
    return { eventId: -1, topic, supersededEventId: null, blocked: 'dev-artifact' };
  }
  const date = input.date ?? localDate();
  // Same-day idempotency: a plain "set belief" upserts in place via ingest's
  // (source, external_id) dedup, so repeated sets on a topic in one day don't
  // pile up. But an EXPLICIT supersede (a retraction or re-confirmation, e.g.
  // from the nightly freshness / corrections-replay passes) MUST append a new
  // event — if it shared the head's external_id it would collapse onto the very
  // row it supersedes, producing a self-reference (`supersedes = own id`) and
  // dropping the prior claim from history. Key those writes by the superseded
  // id so ingest appends instead of upserting, while same-day re-runs of the
  // identical supersede stay idempotent.
  // The same-day exclusion key skips the row being upserted in place so it never
  // supersedes itself. It is computed from the CANONICAL slug — the only case
  // where the exclusion bites is a same-slug same-day re-set, where the canonical
  // and final topics coincide; the gate below can only revert `topic` for a
  // cross-slug head, whose own external_id differs anyway.
  const excludeExternalId =
    input.supersedes != null
      ? `belief:${date}:${canonical}:s${input.supersedes}`
      : `belief:${date}:${canonical}`;

  const findHead = (t: string) =>
    db
      .prepare(
        `SELECT e.id AS id, c.body AS claim, json_extract(e.payload,'$.topic') AS topic
           FROM events e LEFT JOIN events_content c ON c.id = e.content_ref
          WHERE e.kind = ? AND json_extract(e.payload,'$.topic') = ?
            AND json_extract(e.payload,'$.external_id') != ?
          ORDER BY e.ts DESC, e.id DESC LIMIT 1`,
      )
      .get(BELIEF_KIND, t, excludeExternalId) as
      | { id: number; claim: string | null; topic: string }
      | undefined;

  // Two-step head lookup: the canonical slug first, then the plain-normalized
  // input topic as a legacy fallback (heads written before the canonical sweep
  // sit under non-canonical slugs).
  let head = findHead(canonical);
  if (!head && normalized !== canonical) head = findHead(normalized);

  // Cross-slug merge gate (spec §C1): when the head was reached only through
  // canonicalization (its stored slug differs from the caller's plain-normalized
  // one), require claim-text similarity before superseding. Same-slug
  // supersession and explicit `supersedes` keep today's unconditional behavior.
  if (
    head &&
    input.supersedes == null &&
    normalized !== canonical &&
    head.topic !== normalized &&
    !claimsSimilar(head.claim ?? '', input.claim.trim())
  ) {
    head = undefined;
    topic = normalized; // keep the new claim distinct — false merges are worse than duplicates
  }

  if (input.supersedes != null) {
    const row = db
      .prepare(
        `SELECT json_extract(payload,'$.topic') AS topic FROM events WHERE id = ? AND kind = ?`,
      )
      .get(input.supersedes, BELIEF_KIND) as { topic: string } | undefined;
    if (!row)
      throw new Error(`believe: supersedes ${input.supersedes} is not a belief.update event`);
    // Compare CANONICAL forms so a re-confirmation of a legacy (pre-canonical)
    // head — e.g. the nightly freshness pass re-asserting under the canonical
    // slug — validates instead of throwing.
    if (canonicalizeTopic(normalizeTopic(row.topic)) !== canonical)
      throw new Error('believe: supersedes topic mismatch');
  }

  // External id is derived AFTER the gate, from the FINAL stored topic — so a
  // gate-fallback write (under the plain-normalized topic) still dedups against
  // its own same-day re-runs through ingest's (source, external_id) upsert.
  const externalId =
    input.supersedes != null
      ? `belief:${date}:${topic}:s${input.supersedes}`
      : `belief:${date}:${topic}`;

  const supersedes = input.supersedes ?? head?.id ?? null;

  const r = ingest(db, llm, {
    kind: BELIEF_KIND,
    source: BELIEF_SOURCE,
    content: input.claim.trim(),
    payload: {
      topic,
      // Preserve the caller's plain-normalized slug when canonicalization changed
      // the stored topic (gate-fallback writes have topic === normalized, so they
      // skip this). Lets the one-time sweep + audit trail trace where a head came from.
      ...(topic !== normalized ? { original_topic: normalized } : {}),
      supersedes,
      confidence: input.confidence ?? null,
      sources: input.sources ?? [],
      retracted: input.retracted === true,
      provenance: input.provenance ?? 'unknown',
      verified_at: input.verifiedAt ?? new Date().toISOString(),
      external_id: externalId,
    },
  });
  return { eventId: r.eventId, topic, supersededEventId: supersedes };
}

const SELECT = `SELECT e.id AS eventId, e.ts AS ts,
  json_extract(e.payload,'$.topic') AS topic,
  json_extract(e.payload,'$.confidence') AS confidence,
  json_extract(e.payload,'$.retracted') AS retracted,
  json_extract(e.payload,'$.supersedes') AS supersedes,
  json_extract(e.payload,'$.provenance') AS provenance,
  json_extract(e.payload,'$.verified_at') AS verified_at,
  json_extract(e.payload,'$.sources') AS sources,
  c.body AS claim
  FROM events e LEFT JOIN events_content c ON c.id = e.content_ref
  WHERE e.kind = 'belief.update'`;

export function recallBelief(
  db: RobinDb,
  opts: RecallBeliefOptions = {},
): BeliefRecord | BeliefRecord[] | null {
  if (opts.topic) {
    const normalized = normalizeTopic(opts.topic);
    const canonical = canonicalizeTopic(normalized);
    // Lookup symmetry (spec §C1): run the same canonicalizer used at write time
    // on the query so historical, negated, and modifier-tagged topic strings all
    // resolve to the one canonical head. Fall back to the plain-normalized form
    // for legacy heads not yet swept by `robin beliefs canonicalize` and for
    // gate-kept distinct topics (a dissimilar cross-slug write stored under its
    // own plain-normalized slug).
    const lookupHistory = (t: string) =>
      db
        .prepare(
          `${SELECT} AND json_extract(e.payload,'$.topic') = ? ORDER BY e.ts DESC, e.id DESC`,
        )
        .all(t) as RawRow[];
    const lookupHead = (t: string) =>
      db
        .prepare(
          `${SELECT} AND json_extract(e.payload,'$.topic') = ? ORDER BY e.ts DESC, e.id DESC LIMIT 1`,
        )
        .get(t) as RawRow | undefined;

    if (opts.history) {
      const rows = lookupHistory(canonical);
      if (rows.length > 0 || canonical === normalized) return rows.map(mapRow);
      return lookupHistory(normalized).map(mapRow);
    }
    const row =
      lookupHead(canonical) ?? (canonical !== normalized ? lookupHead(normalized) : undefined);
    return row ? mapRow(row) : null;
  }
  const limit = opts.limit ?? 50;
  // Enumerate mode = "what Robin currently believes". A topic whose LATEST head
  // is retracted is no longer believed, so it must not surface here — otherwise
  // retracted dev-artifact tombstones leak into every consumer of the enumerate
  // path (the daily-brief gather, MCP `recall_belief`), where the synthesis pass
  // re-notices them as "churn" and mints fresh meta-beliefs about them. The
  // retracted filter is applied to the per-topic latest head (rn = 1), so a topic
  // is dropped wholesale when its newest belief is a retraction; primer.ts and
  // belief-freshness.ts already skip retracted heads, so this just centralizes
  // that intent at the source.
  const rows = db
    .prepare(
      `${SELECT} AND COALESCE(json_extract(e.payload,'$.retracted'), 0) = 0 AND e.id IN (
         SELECT id FROM (
           SELECT e2.id AS id,
                  ROW_NUMBER() OVER (
                    PARTITION BY json_extract(e2.payload,'$.topic')
                    ORDER BY e2.ts DESC, e2.id DESC
                  ) AS rn
           FROM events e2 WHERE e2.kind='belief.update'
         ) WHERE rn = 1
       ) ORDER BY e.ts DESC, e.id DESC LIMIT ?`,
    )
    .all(limit) as RawRow[];
  return rows.map(mapRow);
}
