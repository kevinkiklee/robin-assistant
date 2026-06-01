import type { LLMDispatcher } from '../llm/dispatcher.ts';
import type { RobinDb } from './db.ts';
import { ageDaysFrom, type ProvenanceClass } from './provenance.ts';

/** Query is truncated to this many chars before embedding — bounds embed latency/cost on
 *  pathological prompts (a pasted file, a giant diff) without hurting recall quality. */
const MAX_EMBED_QUERY_CHARS = 2000;
/** Reciprocal Rank Fusion constant. 60 is the canonical value from the original RRF paper. */
const RRF_K = 60;

export interface RecallOptions {
  limit?: number;
  mode?: 'lex' | 'vec' | 'hybrid';
  /**
   * Drop vector hits whose L2 distance exceeds this floor. `events_vec` is a vec0
   * default-L2 table, so a large distance means "not actually similar". Without a
   * floor, hybrid recall pads its result set with semantically-unrelated rows (the
   * old `1 - distance` score even went negative for distance > 1 yet still ranked
   * them). `undefined` = no floor, preserving prior behavior for existing callers;
   * the auto-recall composer passes an explicit, measured floor.
   */
  maxDistance?: number;
  /** Tags the `recall_log` row so auto-recall noise can later be separated from manual queries. */
  source?: 'auto' | 'manual';
  /** Correlates the recall to a session (auto-recall hot path); stored on the log row. */
  sessionId?: string;
}

export interface RecallHit {
  eventId: number;
  contentId: number;
  body: string;
  score: number;
  source: 'lex' | 'vec';
  /** Event kind tag (e.g. 'belief.update', 'session.captured'). */
  kind?: string;
  /** Days since the event was recorded. */
  ageDays?: number;
  /** Stored confidence — belief.update hits only. */
  confidence?: number | null;
  /** Provenance class — belief.update hits only. */
  provenance?: ProvenanceClass;
}

/**
 * Enrich a hit set with kind, ageDays, and (for belief.update) confidence + provenance.
 * ONE query over the final result set only — never touches the hot FTS/vec scan.
 * Best-effort: any error returns the hits unmodified.
 */
function enrichHits(db: RobinDb, hits: RecallHit[]): RecallHit[] {
  if (hits.length === 0) return hits;
  try {
    const ids = hits.map((h) => h.eventId);
    const placeholders = ids.map(() => '?').join(',');
    const rows = db
      .prepare(`SELECT id, kind, ts, payload FROM events WHERE id IN (${placeholders})`)
      .all(...ids) as Array<{ id: number; kind: string; ts: string; payload: string | null }>;
    const byId = new Map(rows.map((r) => [r.id, r]));
    return hits.map((h) => {
      const row = byId.get(h.eventId);
      if (!row) return h;
      const enriched: RecallHit = { ...h, kind: row.kind, ageDays: ageDaysFrom(row.ts) };
      if (row.kind === 'belief.update' && row.payload) {
        try {
          const p = JSON.parse(row.payload) as Record<string, unknown>;
          enriched.confidence = typeof p.confidence === 'number' ? p.confidence : null;
          enriched.provenance = (p.provenance as ProvenanceClass | undefined) ?? 'unknown';
          // Epistemic age tracks last-verified, not creation — keep this in step
          // with the primer/freshness surfaces (which use verified_at ?? ts).
          if (typeof p.verified_at === 'string') enriched.ageDays = ageDaysFrom(p.verified_at);
        } catch {
          // malformed payload — leave confidence/provenance absent
        }
      }
      return enriched;
    });
  } catch {
    return hits;
  }
}

/**
 * Drop `belief.update` hits that are no longer the live truth. A belief event is
 * surfaced only when it is the current head for its topic (latest by ts,id) AND
 * that head is not retracted. Superseded and retracted belief events stay in the
 * events corpus — and stay FTS/vec-indexed — so without this filter recall happily
 * re-surfaces a claim the belief layer has already overturned (the primer, freshness,
 * and dream passes all filter retracted heads; recall was the one read path that did
 * not). Concretely: an old "Robin uses a SurrealDB backend" assertion that was
 * bulk-retracted but never deleted would keep getting auto-recalled. Non-belief hits
 * pass through untouched. Best-effort: any error returns the hits unfiltered.
 */
function filterStaleBeliefHits(db: RobinDb, hits: RecallHit[]): RecallHit[] {
  if (hits.length === 0) return hits;
  try {
    const ids = hits.map((h) => h.eventId);
    const ph = ids.map(() => '?').join(',');
    const beliefRows = db
      .prepare(
        `SELECT id, json_extract(payload,'$.topic') AS topic
           FROM events WHERE kind = 'belief.update' AND id IN (${ph})`,
      )
      .all(...ids) as Array<{ id: number; topic: string | null }>;
    if (beliefRows.length === 0) return hits; // no belief hits → nothing to filter

    const topicByEvent = new Map(beliefRows.map((r) => [r.id, r.topic]));
    const topics = [...new Set(beliefRows.map((r) => r.topic).filter((t): t is string => !!t))];
    if (topics.length === 0) return hits;

    const tph = topics.map(() => '?').join(',');
    // Current head (+ retracted flag) per topic: the belief.update with the latest (ts,id).
    const heads = db
      .prepare(
        `SELECT topic, headId, retracted FROM (
           SELECT json_extract(payload,'$.topic') AS topic, id AS headId,
                  json_extract(payload,'$.retracted') AS retracted,
                  ROW_NUMBER() OVER (
                    PARTITION BY json_extract(payload,'$.topic')
                    ORDER BY ts DESC, id DESC
                  ) AS rn
             FROM events
            WHERE kind = 'belief.update' AND json_extract(payload,'$.topic') IN (${tph})
         ) WHERE rn = 1`,
      )
      .all(...topics) as Array<{ topic: string; headId: number; retracted: number | null }>;
    const headByTopic = new Map(heads.map((h) => [h.topic, h]));

    return hits.filter((h) => {
      if (!topicByEvent.has(h.eventId)) return true; // not a belief hit — keep
      const topic = topicByEvent.get(h.eventId);
      const head = topic ? headByTopic.get(topic) : undefined;
      if (!head) return true; // head unknown — don't over-filter
      return h.eventId === head.headId && head.retracted !== 1;
    });
  } catch {
    return hits;
  }
}

/** Same idiom as capture.ts dedup hash — base64-truncated so repeat queries collide intentionally. */
function queryHash(query: string): string {
  return Buffer.from(query).toString('base64').slice(0, 64);
}

/**
 * Reciprocal Rank Fusion: merge ranked result lists by `Σ 1/(RRF_K + rank)`, where
 * `rank` is each hit's 0-based position within its own list. Position — not the
 * raw lex/vec score — is all that matters, which sidesteps the incompatible-scale
 * bug of the old additive merge (FTS `-rank` summed with vec `1 - distance`). An
 * item that ranks well in BOTH lists rises to the top. Merge key is `contentId`;
 * the first-seen hit's body/source are kept and its fused score accumulated.
 */
export function fuseRRF(lists: RecallHit[][], limit: number, k = RRF_K): RecallHit[] {
  const fused = new Map<number, RecallHit>();
  for (const list of lists) {
    list.forEach((hit, rank) => {
      const contribution = 1 / (k + rank);
      const existing = fused.get(hit.contentId);
      if (existing) existing.score += contribution;
      else fused.set(hit.contentId, { ...hit, score: contribution });
    });
  }
  return Array.from(fused.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/**
 * Insert a recall_log row for every recall() call, with a deterministic outcome set
 * at log time: `miss` (zero hits) or `answered` (≥1 hit). This closes the loop that
 * previously left every row stuck at `outcome='pending'` (the deferred dream scorer
 * never shipped), making recall precision (`answered / total`) measurable. We also
 * persist `top_score` (the best hit's fused/raw score), the `session_id`, and the
 * surfaced `content_ids` — linkage a richer relevance scorer can use later. `source`
 * separates auto-recall hot-path queries from manual/MCP ones.
 */
function logRecall(
  db: RobinDb,
  query: string,
  hits: RecallHit[],
  source: 'auto' | 'manual',
  sessionId?: string,
): void {
  try {
    const outcome = hits.length === 0 ? 'miss' : 'answered';
    const topScore = hits.length > 0 ? hits[0].score : null;
    const contentIds = JSON.stringify(hits.map((h) => h.contentId));
    db.prepare(
      `INSERT INTO recall_log
         (ts, query_hash, result_count, source, outcome, top_score, session_id, injected_content_ids)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      new Date().toISOString(),
      queryHash(query),
      hits.length,
      source,
      outcome,
      topScore,
      sessionId ?? null,
      contentIds,
    );
  } catch {
    // Logging is best-effort; never let it block the recall response.
  }
}

/**
 * Shared tail for every recall return path: drop stale beliefs, enrich, log, return.
 * Filtering before enrichment keeps a retracted/superseded belief out of both the
 * returned hits and the recall_log content-id set.
 */
function finalize(
  db: RobinDb,
  query: string,
  hits: RecallHit[],
  source: 'auto' | 'manual',
  sessionId: string | undefined,
): RecallHit[] {
  const live = filterStaleBeliefHits(db, hits);
  const enriched = enrichHits(db, live);
  logRecall(db, query, enriched, source, sessionId);
  return enriched;
}

export async function recall(
  db: RobinDb,
  llm: LLMDispatcher | null,
  query: string,
  opts: RecallOptions = {},
): Promise<RecallHit[]> {
  const limit = opts.limit ?? 10;
  const mode = opts.mode ?? (llm ? 'hybrid' : 'lex');
  const source = opts.source ?? 'manual';
  const sessionId = opts.sessionId;

  const lexHits: RecallHit[] = [];
  // FTS5 treats hyphen, colon, asterisk, and bare AND/OR/NOT/NEAR as operators. A natural
  // query like "next-step" or "user's photos" raises SQLITE_ERROR. Strip the operators so
  // conversational queries don't crash — power-user operator queries are not a real use case
  // for personal-memory recall and can be added later if needed.
  const sanitized = query
    .replace(/[-:*"^]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  let lexRows: Array<{
    contentId: number;
    body: string;
    rank: number;
    eventId: number | null;
  }> = [];
  if (sanitized) {
    try {
      lexRows = db
        .prepare(`
      SELECT events_content.id AS contentId, events_content.body AS body, rank,
             (SELECT id FROM events WHERE content_ref = events_content.id LIMIT 1) AS eventId
        FROM events_content_fts
        JOIN events_content ON events_content.id = events_content_fts.rowid
       WHERE events_content_fts MATCH ?
       ORDER BY rank
       LIMIT ?
    `)
        .all(sanitized, limit) as typeof lexRows;
    } catch {
      // Malformed FTS5 syntax slipped past the sanitizer (rare; bare reserved keyword like
      // "AND" still parses as operator). Treat as zero lex hits and let vec carry the load.
      lexRows = [];
    }
  }
  for (const r of lexRows) {
    if (r.eventId !== null) {
      lexHits.push({
        eventId: r.eventId,
        contentId: r.contentId,
        body: r.body,
        score: -r.rank,
        source: 'lex',
      });
    }
  }
  if (mode === 'lex' || !llm) {
    return finalize(db, query, lexHits, source, sessionId);
  }

  const vecHits: RecallHit[] = [];
  try {
    // Truncate before embedding — a pasted file or giant diff shouldn't blow up embed
    // latency/cost, and the leading 2k chars carry the topical signal recall needs.
    const [vec] = await llm.embed('embed', query.slice(0, MAX_EMBED_QUERY_CHARS));
    const buf = Buffer.from(new Float32Array(vec).buffer);
    const vecRows = db
      .prepare(`
      SELECT events_content.id AS contentId, events_content.body AS body, distance,
             (SELECT id FROM events WHERE content_ref = events_content.id LIMIT 1) AS eventId
        FROM events_vec
        JOIN events_content ON events_content.id = events_vec.rowid
       WHERE events_vec.embedding MATCH ? AND k = ?
       ORDER BY distance
    `)
      .all(buf, limit) as Array<{
      contentId: number;
      body: string;
      distance: number;
      eventId: number | null;
    }>;
    for (const r of vecRows) {
      // L2 distance floor: drop hits the embedding model considers far. Skipped when
      // maxDistance is undefined so existing callers see no behavior change.
      if (opts.maxDistance !== undefined && r.distance > opts.maxDistance) continue;
      if (r.eventId !== null) {
        vecHits.push({
          eventId: r.eventId,
          contentId: r.contentId,
          body: r.body,
          score: 1 - r.distance,
          source: 'vec',
        });
      }
    }
  } catch {
    return finalize(db, query, lexHits, source, sessionId);
  }

  if (mode === 'vec') {
    return finalize(db, query, vecHits, source, sessionId);
  }

  return finalize(db, query, fuseRRF([lexHits, vecHits], limit), source, sessionId);
}
