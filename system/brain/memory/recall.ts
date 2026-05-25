import type { LLMDispatcher } from '../llm/dispatcher.ts';
import type { RobinDb } from './db.ts';
import { ageDaysFrom, type ProvenanceClass } from './provenance.ts';

export interface RecallOptions {
  limit?: number;
  mode?: 'lex' | 'vec' | 'hybrid';
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

/** Same idiom as capture.ts dedup hash — base64-truncated so repeat queries collide intentionally. */
function queryHash(query: string): string {
  return Buffer.from(query).toString('base64').slice(0, 64);
}

/**
 * Insert a recall_log row for every recall() call. The row starts with outcome='pending';
 * downstream cognition (dream's recall-feedback step, future) updates it once it can score
 * whether the surfaced answer was actually used. Storing every call lets us answer "are we
 * recalling junk?" via aggregation later — the audit cost is one tiny row per query.
 */
function logRecall(db: RobinDb, query: string, resultCount: number): void {
  try {
    db.prepare(`INSERT INTO recall_log (ts, query_hash, result_count) VALUES (?, ?, ?)`).run(
      new Date().toISOString(),
      queryHash(query),
      resultCount,
    );
  } catch {
    // Logging is best-effort; never let it block the recall response.
  }
}

export async function recall(
  db: RobinDb,
  llm: LLMDispatcher | null,
  query: string,
  opts: RecallOptions = {},
): Promise<RecallHit[]> {
  const limit = opts.limit ?? 10;
  const mode = opts.mode ?? (llm ? 'hybrid' : 'lex');

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
    const enriched = enrichHits(db, lexHits);
    logRecall(db, query, enriched.length);
    return enriched;
  }

  const vecHits: RecallHit[] = [];
  try {
    const [vec] = await llm.embed('embed', query);
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
    const enriched = enrichHits(db, lexHits);
    logRecall(db, query, enriched.length);
    return enriched;
  }

  if (mode === 'vec') {
    const enriched = enrichHits(db, vecHits);
    logRecall(db, query, enriched.length);
    return enriched;
  }

  const merged = new Map<number, RecallHit>();
  for (const h of [...lexHits, ...vecHits]) {
    const existing = merged.get(h.contentId);
    if (existing) merged.set(h.contentId, { ...existing, score: existing.score + h.score });
    else merged.set(h.contentId, h);
  }
  const result = Array.from(merged.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  const enriched = enrichHits(db, result);
  logRecall(db, query, enriched.length);
  return enriched;
}
