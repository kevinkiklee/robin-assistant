import type { LLMDispatcher } from '../llm/dispatcher.ts';
import { believe, normalizeTopic } from './belief.ts';
import type { RobinDb } from './db.ts';
import { PROMOTION_THRESHOLD, type ProvenanceClass } from './provenance.ts';

/**
 * Render a Date in SQLite's `datetime('now')` format (`YYYY-MM-DD HH:MM:SS`,
 * UTC) so string comparisons against the `created_at`/`resolved_at` columns —
 * which default to `datetime('now')` — are apples-to-apples (an ISO `T…Z`
 * string sorts inconsistently against the space-separated SQLite form).
 */
function sqliteUtc(d: Date): string {
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * Machine-drafted, unverified belief proposals. The biographer's second
 * extraction pass lands declarative claims here as `pending`; they are NEVER
 * written to the `belief.update` truth stream directly. Promotion is always an
 * explicit review action (`resolveBeliefCandidate`), which routes through the
 * existing `believe()` so supersession is inherited for free. Stale pending
 * candidates expire (→ `rejected`) so the queue cannot grow without bound.
 */
export interface BeliefCandidate {
  id: number;
  topic: string;
  claim: string;
  confidence: number | null;
  sourceEventId: number | null;
  provenance: ProvenanceClass | null;
  status: 'pending' | 'promoted' | 'rejected';
  createdAt: string;
  resolvedAt: string | null;
}

interface RawRow {
  id: number;
  topic: string;
  claim: string;
  confidence: number | null;
  source_event_id: number | null;
  provenance: ProvenanceClass | null;
  status: 'pending' | 'promoted' | 'rejected';
  created_at: string;
  resolved_at: string | null;
}

function mapRow(r: RawRow): BeliefCandidate {
  return {
    id: r.id,
    topic: r.topic,
    claim: r.claim,
    confidence: r.confidence,
    sourceEventId: r.source_event_id,
    provenance: r.provenance,
    status: r.status,
    createdAt: r.created_at,
    resolvedAt: r.resolved_at,
  };
}

// ─── Dev-artifact / Robin-internals claim filter ─────────────────────────────
// The CLAIMS_SYSTEM_PROMPT forbids claims about Robin's own internals and
// engineering artifacts, but the LLM emits them anyway (observed 2026-05-28:
// 110 promoted beliefs about launchd/Pulumi/Vercel/recall.js/monorepo layout
// after a backlog drain). The prompt is a soft contract; this is the hard one.
// A claim is dropped when its text is *about the machinery*, not about Kevin's
// life. Matched on the claim body (not the topic slug) so paraphrases are caught.
// Tokens that are UNAMBIGUOUSLY about machinery — never part of a durable
// life-fact. Ambiguous tokens that also appear in legit user preferences
// (pnpm, Next.js/`.js`, vercel, "deploys to", playwright, sqlite, schema,
// migration) are deliberately EXCLUDED: the machinery claims that use them all
// lead with "Robin"/"askrobin", which the leading-subject check below catches.
// Keeping them here would drop the prompt's own keep-example ("kevin prefers pnpm").
const DEV_ARTIFACT_CLAIM_RE =
  /\b(launchd|daemon|cron(?:tab|\s?job)?|plist|monorepo|dockerfile|pulumi|fly\.io|recall\.js|_journal\.json|robinmark|integration tick|biographer|dream pass|hygiene pass|cognition job|mcp servers?|mcp__|mcp tool|claude code|claude agent sdk|analytics-mcp|chrome-devtools|\.claude\.json|~\/\.claude|tsconfig|github integration|infra\/|apps\/web|repo(?:sitory)? (?:contains|structure|layout)|zsh alias|shell config|launch agent|capture-rules)\b/i;

// Transient / episodic observations wrongly drafted as durable beliefs — WHOOP
// daily-recovery sequences, "resolved on night N", dated metric arrows. These
// are point-in-time readings (belong in the event stream, decay within days),
// not stable facts. Tuned NOT to catch durable patterns that merely use arrows
// (museum photowalk routes "Cooper Hewitt → Guggenheim", music comfort-loops).
const TRANSIENT_CLAIM_RE =
  /(resolved on night|fully resolved as of|recovery climbed|provisional[- ]rescore|\d+%?\s*\(\d{1,2}\/\d{1,2}\)\s*→|\brecovery (?:hit|dipped|dropped|climbed)\b)/i;

/**
 * Returns true when a candidate claim is about Robin's own internals or
 * engineering artifacts (not Kevin's life), OR is a transient episodic reading
 * (not a durable fact) — the hard backstop for the soft prompt rules. Dropped
 * before reaching the candidate queue. Self-referential ("Robin runs as…",
 * "Robin's scheduler…") and infra-shaped ("askrobin.io uses Pulumi") are caught
 * by both the regex and the leading-subject checks.
 */
export function isLowQualityClaim(_topic: string, claim: string): boolean {
  if (DEV_ARTIFACT_CLAIM_RE.test(claim)) return true;
  if (TRANSIENT_CLAIM_RE.test(claim)) return true;
  // Self-referential claims about the assistant — leading "Robin", "Robin's",
  // "The Robin…", "askrobin…". The \b after "robin" matches the apostrophe in
  // "Robin's", so possessive forms are caught too.
  if (/^(robin|the robin|askrobin)\b/i.test(claim.trim())) return true;
  // Claims whose subject is a Robin package/repo, not Kevin.
  if (/^(robin-assistant|_robin-sync|robin-cursor|robin-gemini)/i.test(claim.trim())) return true;
  return false;
}

/**
 * Insert a candidate belief. The topic is normalized to its canonical form.
 * Idempotent against duplicate pending proposals: if an identical pending
 * topic+claim already exists, the existing id is returned and no row is added
 * (keeps a chatty biographer from flooding the review queue with dupes).
 * Returns `{ id: -1 }` (a sentinel, no row written) when the claim is filtered
 * as a dev/engineering artifact — see `isLowQualityClaim`.
 */
export function insertBeliefCandidate(
  db: RobinDb,
  input: {
    topic: string;
    claim: string;
    confidence?: number | null;
    sourceEventId?: number | null;
    provenance?: ProvenanceClass | null;
  },
): { id: number } {
  const topic = normalizeTopic(input.topic);
  if (!topic) throw new Error('insertBeliefCandidate: topic required');
  const claim = input.claim?.trim();
  if (!claim) throw new Error('insertBeliefCandidate: claim required');
  if (isLowQualityClaim(topic, claim)) return { id: -1 };

  const existing = db
    .prepare(
      `SELECT id FROM belief_candidates
        WHERE status = 'pending' AND topic = ? AND claim = ?
        ORDER BY id DESC LIMIT 1`,
    )
    .get(topic, claim) as { id: number } | undefined;
  if (existing) return { id: existing.id };

  const info = db
    .prepare(
      `INSERT INTO belief_candidates (topic, claim, confidence, source_event_id, provenance)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      topic,
      claim,
      input.confidence ?? null,
      input.sourceEventId ?? null,
      input.provenance ?? null,
    );
  return { id: Number(info.lastInsertRowid) };
}

/** List candidates, newest-first, optionally filtered by status. */
export function listBeliefCandidates(
  db: RobinDb,
  opts: { status?: 'pending' | 'promoted' | 'rejected'; limit?: number } = {},
): BeliefCandidate[] {
  const limit = opts.limit ?? 50;
  const rows = opts.status
    ? (db
        .prepare(
          `SELECT * FROM belief_candidates WHERE status = ?
            ORDER BY created_at DESC, id DESC LIMIT ?`,
        )
        .all(opts.status, limit) as RawRow[])
    : (db
        .prepare(`SELECT * FROM belief_candidates ORDER BY created_at DESC, id DESC LIMIT ?`)
        .all(limit) as RawRow[]);
  return rows.map(mapRow);
}

/**
 * Resolve a pending candidate. `promote` routes the claim through `believe()`
 * (inheriting supersession) and marks the candidate `promoted`, returning the
 * new belief event id. `reject` marks it `rejected` with no truth-stream write.
 * Resolving a non-pending (or missing) candidate is a no-op aside from the
 * `believe()` call being skipped.
 *
 * P3 formation gate: when `action === 'promote'`, two checks gate actual promotion:
 *   1. `external` provenance — external readings are live state (read from the
 *      integration on demand), never durable beliefs; the request is re-routed to
 *      `reject` with blockedReason='external-not-durable'.
 *   2. a *present* confidence below the class threshold — self-flagged weak
 *      candidates cannot promote; re-routed to `reject` with
 *      blockedReason='below-threshold-for-class'. A NULL confidence is reviewer's
 *      discretion (promotion is the explicit review action) and is honored.
 *
 * Intentional design decision: we do NOT apply an additional confidence ceiling
 * when promoting weak-class beliefs. Read-time decay (effectiveConfidence, applied
 * to inferred beliefs) plus the provenance tag already de-weight weak beliefs when
 * surfaced; adding a stored-confidence cap here would double-discount them.
 */
export function resolveBeliefCandidate(
  db: RobinDb,
  llm: LLMDispatcher | null,
  id: number,
  action: 'promote' | 'reject',
  reason?: string,
): {
  candidateId: number;
  action: 'promote' | 'reject';
  promotedBeliefEventId: number | null;
  blockedReason?: string;
} {
  void reason;
  const row = db.prepare(`SELECT * FROM belief_candidates WHERE id = ?`).get(id) as
    | RawRow
    | undefined;
  if (!row) throw new Error(`resolveBeliefCandidate: candidate ${id} not found`);
  if (row.status !== 'pending') {
    throw new Error(`resolveBeliefCandidate: candidate ${id} already ${row.status}`);
  }

  const now = sqliteUtc(new Date());

  if (action === 'reject') {
    db.prepare(
      `UPDATE belief_candidates SET status = 'rejected', resolved_at = ? WHERE id = ?`,
    ).run(now, id);
    return { candidateId: id, action, promotedBeliefEventId: null };
  }

  // P3 formation gate — check provenance class before allowing promotion.
  const cls: ProvenanceClass = row.provenance ?? 'unknown';

  if (cls === 'external') {
    // External readings are live state (fetched from integrations on demand).
    // They are NOT durable beliefs — promoting one would create a stale snapshot
    // that drifts from the live source. Re-route to rejected.
    db.prepare(
      `UPDATE belief_candidates SET status = 'rejected', resolved_at = ? WHERE id = ?`,
    ).run(now, id);
    return {
      candidateId: id,
      action: 'reject',
      promotedBeliefEventId: null,
      blockedReason: 'external-not-durable',
    };
  }

  if (row.confidence != null && row.confidence < PROMOTION_THRESHOLD[cls]) {
    // The extractor assigned a confidence and it is below the class's minimum
    // bar — reject rather than promote a self-flagged weak belief. A NULL
    // confidence is left to reviewer discretion (promotion is itself the
    // explicit review action): we honor the promote and tag it with its class
    // rather than block it, since `external` — the only categorical block — was
    // already routed out above.
    db.prepare(
      `UPDATE belief_candidates SET status = 'rejected', resolved_at = ? WHERE id = ?`,
    ).run(now, id);
    return {
      candidateId: id,
      action: 'reject',
      promotedBeliefEventId: null,
      blockedReason: 'below-threshold-for-class',
    };
  }

  const res = believe(db, llm, {
    topic: row.topic,
    claim: row.claim,
    confidence: row.confidence ?? undefined,
    provenance: cls,
    sources: row.source_event_id != null ? [row.source_event_id] : [],
  });
  db.prepare(`UPDATE belief_candidates SET status = 'promoted', resolved_at = ? WHERE id = ?`).run(
    now,
    id,
  );
  return { candidateId: id, action: 'promote', promotedBeliefEventId: res.eventId };
}

/** Count candidates still awaiting review. */
export function countPendingCandidates(db: RobinDb): number {
  const r = db
    .prepare(`SELECT COUNT(*) AS c FROM belief_candidates WHERE status = 'pending'`)
    .get() as { c: number };
  return r.c;
}

/**
 * Expire pending candidates whose `created_at` predates the cutoff (default 14
 * days), setting them to `rejected` with a `resolved_at`. Returns the number
 * expired. `now` is injectable for deterministic tests.
 */
export function expireStaleCandidates(
  db: RobinDb,
  olderThanDays = 14,
  now: Date = new Date(),
): number {
  const cutoff = sqliteUtc(new Date(now.getTime() - olderThanDays * 24 * 60 * 60 * 1000));
  const info = db
    .prepare(
      `UPDATE belief_candidates SET status = 'rejected', resolved_at = ?
        WHERE status = 'pending' AND created_at < ?`,
    )
    .run(sqliteUtc(now), cutoff);
  return info.changes;
}
