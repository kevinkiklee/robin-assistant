import type { LLMDispatcher } from '../llm/dispatcher.ts';
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

export function normalizeTopic(topic: string): string {
  return topic.trim().toLowerCase().replace(/_/g, '-').replace(/\s+/g, '-').replace(/-+/g, '-');
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
  const date = input.date ?? localDate();
  const externalId = `belief:${date}:${topic}`;

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
  const rows = db
    .prepare(
      `${SELECT} AND e.id IN (
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
