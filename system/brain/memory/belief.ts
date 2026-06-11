import type { LLMDispatcher } from '../llm/dispatcher.ts';
import { isLowQualityClaim } from './belief-quality.ts';
import type { RobinDb } from './db.ts';
import { ingest } from './ingest.ts';
import type { ProvenanceClass } from './provenance.ts';

const BELIEF_KIND = 'belief.update';
const BELIEF_SOURCE = 'belief';

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
  const topic = normalizeTopic(input.topic);
  if (!topic) throw new Error('believe: topic required');
  if (!input.claim?.trim()) throw new Error('believe: claim required');
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
  const externalId =
    input.supersedes != null
      ? `belief:${date}:${topic}:s${input.supersedes}`
      : `belief:${date}:${topic}`;

  const head = db
    .prepare(
      `SELECT id FROM events
       WHERE kind = ? AND json_extract(payload,'$.topic') = ?
         AND json_extract(payload,'$.external_id') != ?
       ORDER BY ts DESC, id DESC LIMIT 1`,
    )
    .get(BELIEF_KIND, topic, externalId) as { id: number } | undefined;

  if (input.supersedes != null) {
    const row = db
      .prepare(
        `SELECT json_extract(payload,'$.topic') AS topic FROM events WHERE id = ? AND kind = ?`,
      )
      .get(input.supersedes, BELIEF_KIND) as { topic: string } | undefined;
    if (!row)
      throw new Error(`believe: supersedes ${input.supersedes} is not a belief.update event`);
    if (normalizeTopic(row.topic) !== topic) throw new Error('believe: supersedes topic mismatch');
  }

  const supersedes = input.supersedes ?? head?.id ?? null;

  const r = ingest(db, llm, {
    kind: BELIEF_KIND,
    source: BELIEF_SOURCE,
    content: input.claim.trim(),
    payload: {
      topic,
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
    const topic = normalizeTopic(opts.topic);
    if (opts.history) {
      const rows = db
        .prepare(
          `${SELECT} AND json_extract(e.payload,'$.topic') = ? ORDER BY e.ts DESC, e.id DESC`,
        )
        .all(topic) as RawRow[];
      return rows.map(mapRow);
    }
    const row = db
      .prepare(
        `${SELECT} AND json_extract(e.payload,'$.topic') = ? ORDER BY e.ts DESC, e.id DESC LIMIT 1`,
      )
      .get(topic) as RawRow | undefined;
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
