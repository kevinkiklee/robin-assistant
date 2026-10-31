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
  /** Injectable reference time for the verdict-default expiry stamp (tests). */
  now?: Date;
  /** Initial status — `suppressed` for recs logged past the creation cap (default open). */
  status?: 'open' | 'suppressed';
}

/**
 * Insert a new `open` recommendation. `created_at` defaults to now. Returns the new id.
 * `confidence` is clamped to 0..1; an empty `subject`/`claim` is a programmer error.
 * When no `expiresAt` is given, the verdict-default expiry is stamped so every new rec
 * has an explicit lifecycle (design 2026-08-10 §4).
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
      ? defaultExpiresAt(input.verdict ?? null, input.now ?? new Date())
      : input.expiresAt instanceof Date
        ? sqliteUtc(input.expiresAt)
        : input.expiresAt;

  const info = db
    .prepare(
      `INSERT INTO recommendations (
         subject, claim, reasoning, verdict, domain, confidence,
         source_event_id, expires_at, status
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      input.status ?? 'open',
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
 * Verdicts whose advice is to NOT act (now). Following them means no action, so a
 * window that passes without a contrary action resolves `held`, a matching action is
 * CONTRARY (resolves `declined`), and they never count toward the acted-rate.
 */
export const HOLD_VERDICTS: ReadonlySet<Verdict> = new Set<Verdict>(['skip', 'avoid', 'wait']);

/** True for a skip/avoid/wait stance. */
export function isHoldVerdict(verdict: Verdict | null): boolean {
  return verdict != null && HOLD_VERDICTS.has(verdict);
}

/**
 * Resolve a hold-type rec whose window passed with no contrary action: `status=held`,
 * `outcome=not_acted` (he did not act on the thing — which is what the advice asked).
 */
export function holdRecommendation(db: RobinDb, id: number, at?: Date | string): void {
  resolveRecommendation(db, id, {
    status: 'held',
    outcome: 'not_acted',
    actedAt: at,
    evidence: 'held: window passed with no contrary action',
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

const MS_PER_DAY = 86_400_000;

/** Type-aware default expiry, in days, by verdict (design 2026-08-10 §4). */
export function verdictExpiryDays(verdict: Verdict | null): number {
  switch (verdict) {
    case 'buy':
    case 'try':
      return 30;
    case 'skip':
    case 'avoid':
      return 90;
    default:
      return 60; // wait / other / no verdict
  }
}

/** Explicit expiry stamp for a new rec with none supplied: now + verdict default. */
export function defaultExpiresAt(verdict: Verdict | null, now: Date): string {
  return sqliteUtc(new Date(now.getTime() + verdictExpiryDays(verdict) * MS_PER_DAY));
}

/** Normalized creation-time dedup key (equality — NOT the linker's containment rule). */
export function normalizeSubject(subject: string): string {
  return normalizeText(subject);
}

/** Open recs whose normalized subject equals `subject`'s. The open set is small
 *  (bounded by expiry), so a JS filter over listOpenRecommendations is fine. */
export function findOpenBySubject(db: RobinDb, subject: string): Recommendation[] {
  const key = normalizeText(subject);
  if (!key) return [];
  return listOpenRecommendations(db).filter((r) => normalizeText(r.subject) === key);
}

/** Words that turn a thing into a use of it: "Acme kettle" vs "Acme kettle for pour-over coffee". */
const USE_QUALIFIERS = new Set(['for', 'with', 'on', 'in', 'during', 'at', 'when', 'vs', 'versus']);

/**
 * Do two rec subjects name the same thing? Normalized equality, or one is a contiguous
 * ≥2-token whole-word run inside the other ("Acme Label Maker Pro II" ⊂ "…
 * Pro II (Wide Tape)"). NOT when the longer one adds a use-qualifier: "Acme kettle"
 * (avoid for hard water) and "Acme kettle for pour-over coffee" are different
 * advice about one item (2026-10-03 dedupe dry run). The creation gate and
 * `recommendations dedupe` both use it.
 */
export function subjectsOverlap(a: string, b: string): boolean {
  const na = normalizeText(a);
  const nb = normalizeText(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const [short, long] = na.length <= nb.length ? [na, nb] : [nb, na];
  // subjectMatches(haystack, needle): is the shorter subject a run inside the longer?
  const contained = na.length <= nb.length ? subjectMatches(b, a) : subjectMatches(a, b);
  if (!contained) return false;
  const extra = long.replace(short, ' ').split(/\s+/).filter(Boolean);
  return !extra.some((w) => USE_QUALIFIERS.has(w));
}

/** Open recs whose subject overlaps `subject` (equality or containment). */
export function findOpenOverlapping(db: RobinDb, subject: string): Recommendation[] {
  return listOpenRecommendations(db).filter((r) => subjectsOverlap(r.subject, subject));
}

/** Append a re-recommendation note to the evidence audit trail (duplicate hit). */
export function noteReRecommended(db: RobinDb, id: number, at: Date = new Date()): void {
  const rec = getRecommendation(db, id);
  if (!rec) throw new Error(`noteReRecommended: recommendation ${id} not found`);
  const note = `re-recommended ${sqliteUtc(at).slice(0, 10)}`;
  const evidence = rec.evidence ? `${rec.evidence}; ${note}` : note;
  db.prepare(`UPDATE recommendations SET evidence = ? WHERE id = ?`).run(evidence, id);
}

/** Mark an open rec replaced by a newer stance on the same subject. */
export function supersedeRecommendation(
  db: RobinDb,
  id: number,
  byId: number,
  reason = 'changed stance',
): void {
  resolveRecommendation(db, id, {
    status: 'superseded',
    outcome: 'unknown',
    evidence: `superseded by recommendation #${byId} (${reason})`,
  });
}

/** Parse a stored timestamp to epoch ms (mirror of linker.ts parseTs — SQLite-utc
 *  space form treated as UTC). Replicated to keep store self-contained. */
function parseStoredTs(ts: string): number {
  const iso = ts.includes('T') || ts.endsWith('Z') ? ts : `${ts.replace(' ', 'T')}Z`;
  return new Date(iso).getTime();
}

/** A rec's effective expiry in epoch ms: explicit `expiresAt`, else legacy
 *  created_at + 90d (pre-triage rows). Null when unparseable. */
export function expiryMsOf(rec: Recommendation): number | null {
  if (rec.expiresAt) {
    const ms = parseStoredTs(rec.expiresAt);
    return Number.isNaN(ms) ? null : ms;
  }
  const created = parseStoredTs(rec.createdAt);
  if (Number.isNaN(created)) return null;
  return created + 90 * MS_PER_DAY;
}

/** Open recs lapsing within `withinDays` of `now` — the brief's last-call feed. */
export function listLapsingRecommendations(
  db: RobinDb,
  opts: { withinDays?: number; now?: Date } = {},
): Recommendation[] {
  const now = (opts.now ?? new Date()).getTime();
  const horizon = now + (opts.withinDays ?? 7) * MS_PER_DAY;
  return listOpenRecommendations(db)
    .filter((r) => {
      const ms = expiryMsOf(r);
      return ms != null && ms >= now && ms < horizon;
    })
    .sort((a, b) => (expiryMsOf(a) ?? 0) - (expiryMsOf(b) ?? 0));
}
