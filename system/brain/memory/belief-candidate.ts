import type { LLMDispatcher } from '../llm/dispatcher.ts';
import { believe, normalizeTopic } from './belief.ts';
import type { RobinDb } from './db.ts';
import { embedBodies, embedBody } from './embed-content.ts';
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
  /** How many times the same fact was independently extracted (1 = drafted once). */
  corroborationCount: number;
  /** Why the candidate was resolved (e.g. 'paraphrase-dup'); null while pending. */
  resolvedReason: string | null;
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
  corroboration_count: number;
  resolved_reason: string | null;
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
    corroborationCount: r.corroboration_count ?? 1,
    resolvedReason: r.resolved_reason ?? null,
  };
}

/** Semantic dedup threshold (cosine). Calibrated conservative: paraphrases of the
 *  same fact collapse, related-but-distinct facts (a device vs. its disks) stay
 *  separate. Erring high means an occasional missed merge (harmless — the fact sits
 *  as two candidates), never a false merge that destroys information. */
const DEDUP_COSINE_THRESHOLD = 0.92;

/** Per-request cap when batch-embedding the pending backlog — cloud embedders reject
 *  oversized batchEmbedContents calls, so the sweep embeds in chunks of this size. */
const EMBED_DEDUP_BATCH = 100;

function vecToBlob(vec: number[]): Buffer {
  return Buffer.from(new Float32Array(vec).buffer);
}

function blobToVec(buf: Buffer): Float32Array {
  return new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4));
}

/** Cosine similarity over two equal-length vectors; 0 when either is a zero vector. */
function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
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
  /\b(launchd|daemon|cron(?:tab|\s?job)?|plist|monorepo|turborepo|dockerfile|docker image|pulumi|fly\.io|recall\.js|_journal\.json|robinmark|integration tick|biographer|dream pass|hygiene pass|cognition job|mcp servers?|mcp__|mcp tool|claude code|claude agent sdk|analytics-mcp|chrome-devtools|\.claude\.json|~\/\.claude|tsconfig|github integration|github repository|npm package|surrealdb|sqlite wal|vector index|vitest|playwright|biome|cli-in-vm|vm image|shell-mux|send-keys|infra\/|apps\/web|repo(?:sitory)? (?:contains|structure|layout)|zsh alias|shell config|launch agent|capture-rules|design (?:token|system)|brand accent)\b/i;

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
  const c = claim.trim();
  if (DEV_ARTIFACT_CLAIM_RE.test(c)) return true;
  if (TRANSIENT_CLAIM_RE.test(c)) return true;
  // Self-referential claims whose SUBJECT is the assistant / its sites / its
  // packages — not Kevin. The grammatical subject is the discriminator: a claim
  // ABOUT the machinery is noise; a claim about Kevin that merely mentions it
  // (e.g. "Kevin's GitHub username is …", "Kevin owns askrobin.io") is a real
  // life-fact and is intentionally NOT matched here.
  //   "Robin …", "Robin's …", "The Robin …", "askrobin…", "The askrobin.io …",
  //   "Kevin's Robin assistant …", "Kevin's askrobin.io instance …"
  if (/^(the\s+)?(robin|askrobin)\b/i.test(c)) return true;
  if (/^(kevin'?s|iser'?s)\s+(the\s+)?(robin|askrobin)\b/i.test(c)) return true;
  // Claims whose subject is a Robin package/repo, not Kevin.
  if (/^(robin-assistant|_robin-sync|robin-cursor|robin-gemini)/i.test(c)) return true;
  // Subject is the MCP surface or a *.io project's internals.
  if (/^(mcp__|the\s+\S+\.io\s+(project|vm|app|site|deployment|image))/i.test(c)) return true;
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

/**
 * Insert a candidate with semantic dedup — the embedder-aware entry point the
 * biographer uses. The exact-match `insertBeliefCandidate` only dedups identical
 * `(topic, claim)` pairs, so the biographer's per-run paraphrases of the same fact
 * (under fresh topic slugs) pile up in the pending queue. Here the incoming claim is
 * embedded and compared (cosine) against existing pending candidates; a hit at/above
 * `DEDUP_COSINE_THRESHOLD` is treated as the same fact:
 *
 *   - **Merge, don't insert.** Bump the canonical row's `corroboration_count`.
 *   - **Canonical text only changes for a strictly more-confident variant**, so a
 *     one-off wrong-value paraphrase (the observed `~$390` vs corroborated `~$990`)
 *     can never displace a well-supported one — it just adds corroboration.
 *
 * Degrades safely: a low-quality claim is filtered before any embed (sentinel id
 * `-1`); a missing embedder or a failed embed falls back to the exact-match
 * primitive. Returns `merged: true` when the claim folded into an existing row.
 */
export async function insertCandidateWithDedup(
  db: RobinDb,
  llm: LLMDispatcher | null,
  input: {
    topic: string;
    claim: string;
    confidence?: number | null;
    sourceEventId?: number | null;
    provenance?: ProvenanceClass | null;
  },
): Promise<{ id: number; merged: boolean }> {
  const topic = normalizeTopic(input.topic);
  if (!topic) throw new Error('insertCandidateWithDedup: topic required');
  const claim = input.claim?.trim();
  if (!claim) throw new Error('insertCandidateWithDedup: claim required');
  // Cheap filter first — never spend an embed on a dev-artifact/transient claim.
  if (isLowQualityClaim(topic, claim)) return { id: -1, merged: false };
  // No embedder → exact-match primitive (degrade, never throw).
  if (!llm) return { id: insertBeliefCandidate(db, input).id, merged: false };

  let blob: Buffer;
  try {
    blob = vecToBlob(await embedBody(llm, claim));
  } catch {
    // Embed unavailable/failed — dedup is best-effort; fall back to exact insert.
    return { id: insertBeliefCandidate(db, input).id, merged: false };
  }
  const q = blobToVec(blob);

  const rows = db
    .prepare(
      `SELECT id, claim, confidence, corroboration_count, embedding
         FROM belief_candidates
        WHERE status = 'pending' AND embedding IS NOT NULL`,
    )
    .all() as Array<{
    id: number;
    claim: string;
    confidence: number | null;
    corroboration_count: number;
    embedding: Buffer;
  }>;

  let bestId = 0;
  let bestConfidence: number | null = null;
  let bestSim = 0;
  for (const r of rows) {
    const sim = cosine(q, blobToVec(r.embedding));
    if (sim > bestSim) {
      bestSim = sim;
      bestId = r.id;
      bestConfidence = r.confidence;
    }
  }

  if (bestId > 0 && bestSim >= DEDUP_COSINE_THRESHOLD) {
    const incoming = input.confidence ?? null;
    const adopt = incoming != null && (bestConfidence == null || incoming > bestConfidence);
    if (adopt) {
      db.prepare(
        `UPDATE belief_candidates
            SET corroboration_count = corroboration_count + 1, claim = ?, confidence = ?, embedding = ?
          WHERE id = ?`,
      ).run(claim, incoming, blob, bestId);
    } else {
      db.prepare(
        `UPDATE belief_candidates SET corroboration_count = corroboration_count + 1 WHERE id = ?`,
      ).run(bestId);
    }
    return { id: bestId, merged: true };
  }

  // No semantic match — insert via the primitive, then attach the embedding so the
  // next paraphrase can match against it.
  const { id } = insertBeliefCandidate(db, input);
  if (id > 0) db.prepare(`UPDATE belief_candidates SET embedding = ? WHERE id = ?`).run(blob, id);
  return { id, merged: false };
}

interface SweepCandidate {
  id: number;
  claim: string;
  confidence: number | null;
  corroboration_count: number;
  vec: Float32Array;
}

export interface DedupSweepReport {
  scanned: number;
  clusters: number;
  rejected: number;
  /** Rejections that would happen (dry-run) or did happen, per canonical id. */
  collapsed: Array<{ canonicalId: number; rejectedIds: number[] }>;
}

/**
 * One-time + recurring backlog sweep: collapse paraphrase clusters among existing
 * pending candidates. Rows drafted before insert-time dedup carry no embedding, so we
 * embed them in a batch, then leader-cluster by cosine (no transitive chaining — each
 * unclustered row seeds a cluster and absorbs only rows similar to the seed itself,
 * which keeps the merge conservative). Each multi-member cluster keeps one canonical
 * (most corroborated, then most confident, then newest) and rejects the rest with
 * `resolved_reason='paraphrase-dup'` — non-destructive and reversible. `dryRun` reports
 * the proposed collapse without mutating, so a sweep can be eyeballed before it runs on
 * the live store. Degrades to a no-op when no embedder is available.
 */
export async function dedupePendingCandidates(
  db: RobinDb,
  llm: LLMDispatcher | null,
  opts: { dryRun?: boolean; threshold?: number } = {},
): Promise<DedupSweepReport> {
  const threshold = opts.threshold ?? DEDUP_COSINE_THRESHOLD;
  const empty: DedupSweepReport = { scanned: 0, clusters: 0, rejected: 0, collapsed: [] };
  if (!llm) return empty;

  const rows = db
    .prepare(
      `SELECT id, claim, confidence, corroboration_count, embedding
         FROM belief_candidates WHERE status = 'pending' ORDER BY id`,
    )
    .all() as Array<{
    id: number;
    claim: string;
    confidence: number | null;
    corroboration_count: number;
    embedding: Buffer | null;
  }>;
  if (rows.length === 0) return empty;

  // Embed any rows missing an embedding (one batched call), persisting them unless dry.
  const missing = rows.filter((r) => !r.embedding);
  const embById = new Map<number, Float32Array>();
  for (const r of rows) if (r.embedding) embById.set(r.id, blobToVec(r.embedding));
  if (missing.length > 0) {
    const vecs: number[][] = [];
    try {
      // Chunk the batch — cloud embedders (Gemini batchEmbedContents) cap inputs per
      // request, so a whole-backlog single call would be rejected.
      for (let i = 0; i < missing.length; i += EMBED_DEDUP_BATCH) {
        const part = await embedBodies(
          llm,
          missing.slice(i, i + EMBED_DEDUP_BATCH).map((r) => r.claim),
        );
        vecs.push(...part);
      }
    } catch {
      return empty; // embedder unavailable — best-effort, do nothing
    }
    const persist = db.prepare(`UPDATE belief_candidates SET embedding = ? WHERE id = ?`);
    for (let i = 0; i < missing.length; i++) {
      const blob = vecToBlob(vecs[i]);
      embById.set(missing[i].id, blobToVec(blob));
      if (!opts.dryRun) persist.run(blob, missing[i].id);
    }
  }

  const items: SweepCandidate[] = rows.map((r) => ({
    id: r.id,
    claim: r.claim,
    confidence: r.confidence,
    corroboration_count: r.corroboration_count,
    vec: embById.get(r.id) as Float32Array,
  }));

  // Leader clustering: highest-corroborated rows seed first so the natural canonical
  // anchors the cluster.
  const order = [...items].sort(
    (a, b) => b.corroboration_count - a.corroboration_count || a.id - b.id,
  );
  const assigned = new Set<number>();
  const report: DedupSweepReport = {
    scanned: items.length,
    clusters: 0,
    rejected: 0,
    collapsed: [],
  };
  const now = sqliteUtc(new Date());
  const reject = db.prepare(
    `UPDATE belief_candidates
        SET status = 'rejected', resolved_at = ?, resolved_reason = 'paraphrase-dup'
      WHERE id = ?`,
  );
  const setCanonical = db.prepare(
    `UPDATE belief_candidates SET corroboration_count = ? WHERE id = ?`,
  );

  for (const seed of order) {
    if (assigned.has(seed.id)) continue;
    assigned.add(seed.id);
    const members = [seed];
    for (const other of order) {
      if (assigned.has(other.id)) continue;
      if (cosine(seed.vec, other.vec) >= threshold) {
        assigned.add(other.id);
        members.push(other);
      }
    }
    report.clusters++;
    if (members.length === 1) continue;

    // Canonical: most corroborated, then most confident, then newest (highest id).
    const canonical = members.reduce((best, m) =>
      m.corroboration_count !== best.corroboration_count
        ? m.corroboration_count > best.corroboration_count
          ? m
          : best
        : (m.confidence ?? -1) !== (best.confidence ?? -1)
          ? (m.confidence ?? -1) > (best.confidence ?? -1)
            ? m
            : best
          : m.id > best.id
            ? m
            : best,
    );
    const losers = members.filter((m) => m.id !== canonical.id);
    report.collapsed.push({ canonicalId: canonical.id, rejectedIds: losers.map((l) => l.id) });
    report.rejected += losers.length;
    if (!opts.dryRun) {
      setCanonical.run(members.length, canonical.id);
      for (const l of losers) reject.run(now, l.id);
    }
  }
  return report;
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

  // Dev-artifact backstop at promotion time. insertBeliefCandidate filters at
  // draft time, but candidates drafted before that filter existed (the 05-25..27
  // backlog) sit in the queue unscreened — and promotion is where they would
  // become durable truth. Re-checking here guarantees a dev/Robin-internals claim
  // can never be promoted regardless of when or how it was drafted.
  if (isLowQualityClaim(row.topic, row.claim)) {
    db.prepare(
      `UPDATE belief_candidates SET status = 'rejected', resolved_at = ? WHERE id = ?`,
    ).run(now, id);
    return {
      candidateId: id,
      action: 'reject',
      promotedBeliefEventId: null,
      blockedReason: 'dev-artifact',
    };
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
