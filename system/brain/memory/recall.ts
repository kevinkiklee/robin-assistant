import { clockIso } from '../../lib/clock.ts';
import type { LLMDispatcher } from '../llm/dispatcher.ts';
import type { RobinDb } from './db.ts';
import { buildFtsQuery, contentTerms } from './fts-query.ts';
import { ageDaysFrom, type ProvenanceClass } from './provenance.ts';
import { int8DistanceToFloat, quantizeToInt8Json } from './vec-quantize.ts';

/** Query is truncated to this many chars before embedding — bounds embed latency/cost on
 *  pathological prompts (a pasted file, a giant diff) without hurting recall quality.
 *  Exported so the auto-recall composer can replicate the EXACT embed input when it
 *  pre-embeds the turn query to share with the habit slice (keeps factual recall identical). */
export const MAX_EMBED_QUERY_CHARS = 2000;
/** Reciprocal Rank Fusion constant. 60 is the canonical value from the original RRF paper. */
const RRF_K = 60;
/**
 * With a `kinds` filter the vec0 KNN can't filter on the joined `events.kind`
 * (vec0 only filters its own metadata columns), so we over-fetch k and filter
 * after the join. Measured 2026-10-03 on 60 real prompts against the live
 * 29k-vector table: k=50 → 5.1 live curated hits/prompt within the 0.82 floor,
 * k=400 → 18.0, k=1000 → 19.4 (saturated). KNN cost 22 ms → 33 ms → 64 ms.
 * 8× a 50-row pool = 400 sits at the knee.
 */
const VEC_KIND_OVERFETCH = 8;
const VEC_MAX_K = 1000;

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
  /**
   * Precomputed query embedding to reuse INSTEAD of re-embedding inside recall. The
   * auto-recall composer embeds the turn query once and shares the SAME vector with the
   * habit-injection slice (design §9) so the wire costs zero extra embed calls. Must be
   * the embedding of `query.slice(0, MAX_EMBED_QUERY_CHARS)` (the exact input recall would
   * have embedded) for the factual result to stay byte-identical. Absent (every existing
   * caller) → recall embeds internally exactly as before.
   */
  queryEmbedding?: number[];
  /**
   * Invoked (best-effort) with the inserted recall_log rowid after every successful
   * log write, so a caller can later UPDATE its own row — the auto-recall composer
   * uses it to record the true kept set in `kept_json`. Fires inside logRecall's
   * try, and the callback is wrapped in its own try: a caller bug can neither kill
   * the log write nor break recall()'s return.
   */
  onLogged?: (logRowId: number) => void;
  /**
   * Restrict BOTH branches to events of these kinds, applied inside retrieval (the
   * FTS join and an over-fetched KNN) rather than after it — so a corpus dominated
   * by transcripts/telemetry can't crowd curated rows out of a fixed-size pool.
   * Absent → no kind filter (prior behavior).
   */
  kinds?: readonly string[];
  /**
   * How lexical terms combine. 'all' (default) = every content term must match (the
   * historical implicit-AND); 'any' = OR, ranked by bm25 — right for conversational
   * prompts where an AND of 15 words matches nothing. 'any' needs a floor (below).
   */
  lexMatch?: 'all' | 'any';
  /**
   * Corroboration floor for lexical hits in hybrid mode: a lex hit on an EMBEDDED row
   * survives only when that row's vector distance to the query is ≤ this. bm25 alone
   * can't separate junk from signal (its magnitude scales with query length — a long
   * off-topic prompt scores −27 on junk while "lakeport lodge" scores −22 on the exact
   * belief), but a lexical match the embedding also finds close is real. Rows with no
   * embedding yet (embedder lag, NO_EMBED kinds) fall back to `lexMinTermScore`.
   */
  lexMaxDistance?: number;
  /**
   * bm25 floor, per query content term: a lex hit needs −rank ÷ termCount ≥ this. Used
   * where vector corroboration is unavailable (lex mode, embed failure, un-embedded
   * row). Undefined → no floor.
   */
  lexMinTermScore?: number;
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
  /**
   * Float L2 distance between the query and this row's embedding, when known (every
   * vec hit; lex hits corroborated by the vector branch). The honest relevance signal —
   * the fused RRF score is rank-only, so the top hit always scores 1/60.
   */
  distance?: number;
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
 * The `top_score` written to recall_log. The fused RRF score is position-only (rank-1 is
 * always 1/60 ≈ 0.0167 — 464 of the last month's auto rows logged exactly that), so it
 * says nothing about relevance. When any hit carries a vector distance we log the best
 * vector similarity, `1 − min(distance)` (same scale the `maxDistance` floor uses: 0.18 ⇔
 * distance 0.82). Pure-lexical results fall back to the top hit's raw score (bm25, −rank).
 */
export function topScoreOf(hits: RecallHit[]): number | null {
  if (hits.length === 0) return null;
  let best: number | undefined;
  for (const h of hits) {
    if (h.distance !== undefined && (best === undefined || h.distance < best)) best = h.distance;
  }
  return best !== undefined ? 1 - best : hits[0].score;
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
  onLogged?: (logRowId: number) => void,
): void {
  try {
    const outcome = hits.length === 0 ? 'miss' : 'answered';
    const topScore = topScoreOf(hits);
    const contentIds = JSON.stringify(hits.map((h) => h.contentId));
    const info = db
      .prepare(
        `INSERT INTO recall_log
         (ts, query_hash, result_count, source, outcome, top_score, session_id, injected_content_ids)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        clockIso(),
        queryHash(query),
        hits.length,
        source,
        outcome,
        topScore,
        sessionId ?? null,
        contentIds,
      );
    if (onLogged) {
      try {
        onLogged(Number(info.lastInsertRowid));
      } catch {
        // A caller bug in the callback must not kill logging or recall.
      }
    }
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
  onLogged?: (logRowId: number) => void,
): RecallHit[] {
  const live = filterStaleBeliefHits(db, hits);
  const enriched = enrichHits(db, live);
  logRecall(db, query, enriched, source, sessionId, onLogged);
  return enriched;
}

/** Placeholders + params for an optional `kind IN (…)` clause on the given column. */
function kindClause(
  col: string,
  kinds: readonly string[] | undefined,
): { sql: string; params: string[] } {
  if (!kinds || kinds.length === 0) return { sql: '', params: [] };
  return { sql: ` AND ${col} IN (${kinds.map(() => '?').join(',')})`, params: [...kinds] };
}

interface LexRow {
  contentId: number;
  body: string;
  rank: number;
  eventId: number | null;
  embedded: number;
}

interface VecRow {
  contentId: number;
  body: string;
  distance: number;
  eventId: number | null;
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
  const kinds = opts.kinds && opts.kinds.length > 0 ? opts.kinds : undefined;

  // FTS5 reads punctuation, hyphens, colons, quotes and bare AND/OR/NOT/NEAR as syntax, so
  // a raw conversational prompt raised SQLITE_ERROR (72% of real prompts did, 2026-10-03).
  // buildFtsQuery reduces the text to quoted content terms that can never parse as syntax.
  const ftsQuery = buildFtsQuery(query, opts.lexMatch ?? 'all');
  const termCount = Math.max(1, contentTerms(query).length);
  let lexRows: LexRow[] = [];
  if (ftsQuery) {
    try {
      // The kind filter lives in the correlated event lookup (served by the
      // events(content_ref) index, migration 038), so non-matching kinds drop out
      // BEFORE the LIMIT instead of eating the pool.
      const kc = kindClause('kind', kinds);
      lexRows = db
        .prepare(`
      SELECT * FROM (
        SELECT events_content.id AS contentId, events_content.body AS body, rank,
               events_content.embedding IS NOT NULL AS embedded,
               (SELECT id FROM events WHERE content_ref = events_content.id${kc.sql} LIMIT 1) AS eventId
          FROM events_content_fts
          JOIN events_content ON events_content.id = events_content_fts.rowid
         WHERE events_content_fts MATCH ?
         ORDER BY rank
      ) WHERE eventId IS NOT NULL
       LIMIT ?
    `)
        .all(...kc.params, ftsQuery, limit) as LexRow[];
    } catch {
      // Defensive: buildFtsQuery output always parses, but a corrupt FTS index must not
      // take recall down — treat as zero lex hits and let vec carry the load.
      lexRows = [];
    }
  }
  const lexHits: RecallHit[] = [];
  for (const r of lexRows) {
    if (r.eventId === null) continue;
    lexHits.push({
      eventId: r.eventId,
      contentId: r.contentId,
      body: r.body,
      score: -r.rank,
      source: 'lex',
    });
  }
  // bm25 floor for lex hits that can't be corroborated by the vector branch.
  const passesTermFloor = (h: RecallHit): boolean =>
    opts.lexMinTermScore === undefined || h.score / termCount >= opts.lexMinTermScore;
  const embeddedById = new Map(lexRows.map((r) => [r.contentId, r.embedded === 1]));

  if (mode === 'lex' || !llm) {
    return finalize(db, query, lexHits.filter(passesTermFloor), source, sessionId, opts.onLogged);
  }

  const vecHits: RecallHit[] = [];
  /** Float distance of every KNN candidate (pre-floor) — the lexical corroboration lookup. */
  const knnDistance = new Map<number, number>();
  try {
    // Truncate before embedding — a pasted file or giant diff shouldn't blow up embed
    // latency/cost, and the leading 2k chars carry the topical signal recall needs.
    // Reuse a caller-supplied embedding when present (the auto-recall composer shares its
    // single turn-query embed with the habit slice); otherwise embed here as before.
    const vec =
      opts.queryEmbedding ?? (await llm.embed('embed', query.slice(0, MAX_EMBED_QUERY_CHARS)))[0];
    // events_vec stores int8-quantized vectors — quantize the query the same way.
    const q8 = quantizeToInt8Json(vec);
    let vecRows: VecRow[];
    if (kinds) {
      // vec0 can only filter its own columns inside a KNN, so over-fetch k and apply the
      // kind filter on the join (see VEC_KIND_OVERFETCH for the measurement).
      const k = Math.min(limit * VEC_KIND_OVERFETCH, VEC_MAX_K);
      const kc = kindClause('kind', kinds);
      vecRows = db
        .prepare(`
        SELECT * FROM (
          SELECT knn.contentId AS contentId, events_content.body AS body, knn.distance AS distance,
                 (SELECT id FROM events WHERE content_ref = knn.contentId${kc.sql} LIMIT 1) AS eventId
            FROM (SELECT rowid AS contentId, distance FROM events_vec
                   WHERE embedding MATCH vec_int8(?) AND k = ?) knn
            JOIN events_content ON events_content.id = knn.contentId
        ) WHERE eventId IS NOT NULL
         ORDER BY distance
         LIMIT ?
      `)
        .all(...kc.params, q8, Math.max(k, limit), limit) as VecRow[];
    } else {
      vecRows = db
        .prepare(`
      SELECT events_content.id AS contentId, events_content.body AS body, distance,
             (SELECT id FROM events WHERE content_ref = events_content.id LIMIT 1) AS eventId
        FROM events_vec
        JOIN events_content ON events_content.id = events_vec.rowid
       WHERE events_vec.embedding MATCH vec_int8(?) AND k = ?
       ORDER BY distance
    `)
        .all(q8, limit) as VecRow[];
    }
    for (const r of vecRows) {
      // int8 L2 distance = SCALE × float L2 distance; normalize back so the maxDistance
      // floor and `1 - distance` score keep their float-calibrated meaning (e.g.
      // AUTO_RECALL_MAX_DISTANCE = 0.82 stays valid unchanged).
      const dist = int8DistanceToFloat(r.distance);
      knnDistance.set(r.contentId, dist);
      // L2 distance floor: drop hits the embedding model considers far. Skipped when
      // maxDistance is undefined so existing callers see no behavior change.
      if (opts.maxDistance !== undefined && dist > opts.maxDistance) continue;
      if (r.eventId !== null) {
        vecHits.push({
          eventId: r.eventId,
          contentId: r.contentId,
          body: r.body,
          score: 1 - dist,
          source: 'vec',
          distance: dist,
        });
      }
    }
  } catch {
    return finalize(db, query, lexHits.filter(passesTermFloor), source, sessionId, opts.onLogged);
  }

  if (mode === 'vec') {
    return finalize(db, query, vecHits, source, sessionId, opts.onLogged);
  }

  // Lexical corroboration (lexMaxDistance): an embedded lex hit must also sit close in
  // vector space; an un-embedded one (embedder lag) falls back to the bm25 term floor.
  let lexKept = lexHits;
  if (opts.lexMaxDistance !== undefined) {
    const maxD = opts.lexMaxDistance;
    lexKept = [];
    for (const h of lexHits) {
      const d = knnDistance.get(h.contentId);
      if (d !== undefined && d <= maxD) lexKept.push({ ...h, distance: d });
      else if (!embeddedById.get(h.contentId) && passesTermFloor(h)) lexKept.push(h);
    }
  } else if (opts.lexMinTermScore !== undefined) {
    lexKept = lexHits.filter(passesTermFloor);
  }

  // Carry the vector distance onto the fused hit whichever list it came from first, so
  // downstream floors (sensitive docs) and top_score see it.
  const fused = fuseRRF([lexKept, vecHits], limit).map((h) => {
    const d = knnDistance.get(h.contentId);
    return h.distance === undefined && d !== undefined ? { ...h, distance: d } : h;
  });
  return finalize(db, query, fused, source, sessionId, opts.onLogged);
}
