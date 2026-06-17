import type { RobinDb } from '../../memory/db.ts';
import type { PersonalDomain } from '../../memory/domains.ts';
import type {
  Recommendation,
  RecommendationOutcome,
  RecommendationStatus,
  Verdict,
} from './types.ts';

/**
 * Recommendation→Action Loop (Phase 1) — the `recommendations` store (CRUD + resolve +
 * the linker's subject-match helper). Mirrors the habits-store prepared-statement style
 * (statements built per call, SQLite-utc timestamps for apples-to-apples comparisons).
 *
 * Design ref: docs/design/2026-06-17-recommendation-loop-design.md §3–§5.
 */

/**
 * Render a Date in SQLite's `datetime('now')` format (`YYYY-MM-DD HH:MM:SS`, UTC) so
 * string comparisons against the timestamp columns are apples-to-apples (same idiom as
 * habits-store; an ISO `T…Z` string sorts inconsistently against the SQLite space form).
 */
function sqliteUtc(d: Date): string {
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

interface RawRow {
  id: number;
  subject: string;
  claim: string;
  reasoning: string | null;
  verdict: string | null;
  domain: string;
  confidence: number;
  created_at: string;
  source_event_id: number | null;
  expires_at: string | null;
  status: string;
  outcome: string | null;
  acted_at: string | null;
  action_event_id: number | null;
  evidence: string | null;
}

function mapRow(r: RawRow): Recommendation {
  return {
    id: r.id,
    subject: r.subject,
    claim: r.claim,
    reasoning: r.reasoning,
    verdict: (r.verdict as Verdict | null) ?? null,
    domain: r.domain as PersonalDomain,
    confidence: r.confidence,
    createdAt: r.created_at,
    sourceEventId: r.source_event_id,
    expiresAt: r.expires_at,
    status: r.status as RecommendationStatus,
    outcome: (r.outcome as RecommendationOutcome | null) ?? null,
    actedAt: r.acted_at,
    actionEventId: r.action_event_id,
    evidence: r.evidence,
  };
}

export interface InsertRecommendationInput {
  subject: string;
  claim: string;
  reasoning?: string | null;
  verdict?: Verdict | null;
  domain: PersonalDomain;
  confidence?: number;
  sourceEventId?: number | null;
  expiresAt?: Date | string | null;
}

/**
 * Insert a new `open` recommendation. `created_at` defaults to now. Returns the new id.
 * `confidence` is clamped to 0..1; an empty `subject`/`claim` is a programmer error.
 */
export function insertRecommendation(
  db: RobinDb,
  input: InsertRecommendationInput,
): { id: number } {
  const subject = input.subject?.trim();
  if (!subject) throw new Error('insertRecommendation: subject required');
  const claim = input.claim?.trim();
  if (!claim) throw new Error('insertRecommendation: claim required');
  const confidence = Math.min(1, Math.max(0, input.confidence ?? 0));
  const expiresAt =
    input.expiresAt == null
      ? null
      : input.expiresAt instanceof Date
        ? sqliteUtc(input.expiresAt)
        : input.expiresAt;

  const info = db
    .prepare(
      `INSERT INTO recommendations (
         subject, claim, reasoning, verdict, domain, confidence,
         source_event_id, expires_at, status
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open')`,
    )
    .run(
      subject,
      claim,
      input.reasoning ?? null,
      input.verdict ?? null,
      input.domain,
      confidence,
      input.sourceEventId ?? null,
      expiresAt,
    );
  return { id: Number(info.lastInsertRowid) };
}

/** Fetch one recommendation by id, or null. */
export function getRecommendation(db: RobinDb, id: number): Recommendation | null {
  const row = db.prepare(`SELECT * FROM recommendations WHERE id = ?`).get(id) as
    | RawRow
    | undefined;
  return row ? mapRow(row) : null;
}

/** List recommendations, optionally filtered by status, newest-created first. */
export function listRecommendations(
  db: RobinDb,
  opts: { status?: RecommendationStatus } = {},
): Recommendation[] {
  const rows = opts.status
    ? (db
        .prepare(`SELECT * FROM recommendations WHERE status = ? ORDER BY created_at DESC, id DESC`)
        .all(opts.status) as RawRow[])
    : (db
        .prepare(`SELECT * FROM recommendations ORDER BY created_at DESC, id DESC`)
        .all() as RawRow[]);
  return rows.map(mapRow);
}

/** All `open` recommendations (the linker's working set), newest-created first. */
export function listOpenRecommendations(db: RobinDb): Recommendation[] {
  return listRecommendations(db, { status: 'open' });
}

export interface ResolveRecommendationInput {
  status: RecommendationStatus;
  outcome: RecommendationOutcome;
  actedAt?: Date | string;
  actionEventId?: number | null;
  evidence?: string | null;
}

/**
 * Resolve a recommendation: set its terminal `status` + `outcome`, and (when the action
 * was detected/linked) the `acted_at`, `action_event_id`, and `evidence` audit fields.
 * Throws if the recommendation does not exist. Used by both the explicit
 * `resolve_recommendation` MCP path and the deterministic linker.
 */
export function resolveRecommendation(
  db: RobinDb,
  id: number,
  input: ResolveRecommendationInput,
): void {
  const existing = getRecommendation(db, id);
  if (!existing) throw new Error(`resolveRecommendation: recommendation ${id} not found`);
  const actedAt =
    input.actedAt == null
      ? null
      : input.actedAt instanceof Date
        ? sqliteUtc(input.actedAt)
        : input.actedAt;
  db.prepare(
    `UPDATE recommendations
        SET status = ?, outcome = ?, acted_at = ?, action_event_id = ?, evidence = ?
      WHERE id = ?`,
  ).run(
    input.status,
    input.outcome,
    actedAt,
    input.actionEventId ?? null,
    input.evidence ?? null,
    id,
  );
}

/**
 * Expire an open recommendation past its `expires_at`: `status=expired`,
 * `outcome=not_acted`, with an `evidence` note. A thin wrapper over
 * `resolveRecommendation` so the linker's expiry branch reads declaratively.
 */
export function expireRecommendation(db: RobinDb, id: number, at?: Date | string): void {
  resolveRecommendation(db, id, {
    status: 'expired',
    outcome: 'not_acted',
    actedAt: at,
    evidence: 'expired: passed expires_at with no matching action',
  });
}

/**
 * High-precision subject match — the linker's link key (§5.3). Does a behavioral
 * signal's `object` canonically match a recommendation's `subject`? Conservative by
 * design: case-insensitive, trimmed, MULTI-TOKEN named-entity match, NO fuzzy/semantic
 * matching (that is the deferred LLM path).
 *
 * This deliberately reuses the SAME rule as Phase 2 Tier A's exact-entity match
 * (`statementContainsEntity` in behavior/tier-a.ts) — they must agree so a purchase that
 * reinforces a habit also resolves the matching recommendation. Replicated here (rather
 * than imported) to keep the recommendations subsystem self-contained, but the logic is
 * intentionally identical: normalize both sides to lowercase word-runs, require the
 * object to be ≥2 normalized tokens (a bare single word like "lens"/"gear" is too
 * ambiguous and is rejected), and require it to appear as a contiguous whole-word run
 * inside the subject (word-boundary anchored, so "art" never matches "smart").
 */
export function subjectMatches(subject: string, object: string): boolean {
  const obj = normalizeText(object);
  if (!obj) return false;
  // ≥2 tokens → a specific named entity. Single words are too ambiguous (the §7
  // over-attribution risk); they are deferred to the LLM path.
  if (obj.split(' ').length < 2) return false;
  const haystack = ` ${normalizeText(subject)} `;
  return haystack.includes(` ${obj} `);
}

/**
 * Tokenize text to a normalized lowercase word-run for `subjectMatches` (punctuation →
 * single spaces). Identical normalization to tier-a's `normalizeText`.
 */
function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}
