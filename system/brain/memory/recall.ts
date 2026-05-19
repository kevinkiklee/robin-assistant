import type { RobinDb } from './db.ts';
import type { LLMDispatcher } from '../llm/dispatcher.ts';

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
  const lexRows = db.prepare(`
    SELECT events_content.id AS contentId, events_content.body AS body, rank,
           (SELECT id FROM events WHERE content_ref = events_content.id LIMIT 1) AS eventId
      FROM events_content_fts
      JOIN events_content ON events_content.id = events_content_fts.rowid
     WHERE events_content_fts MATCH ?
     ORDER BY rank
     LIMIT ?
  `).all(query, limit) as Array<{ contentId: number; body: string; rank: number; eventId: number | null }>;
  for (const r of lexRows) {
    if (r.eventId !== null) {
      lexHits.push({ eventId: r.eventId, contentId: r.contentId, body: r.body, score: -r.rank, source: 'lex' });
    }
  }
  if (mode === 'lex' || !llm) return lexHits;

  let vecHits: RecallHit[] = [];
  try {
    const [vec] = await llm.embed('embed', query);
    const buf = Buffer.from(new Float32Array(vec).buffer);
    const vecRows = db.prepare(`
      SELECT events_content.id AS contentId, events_content.body AS body, distance,
             (SELECT id FROM events WHERE content_ref = events_content.id LIMIT 1) AS eventId
        FROM events_vec
        JOIN events_content ON events_content.id = events_vec.rowid
       WHERE events_vec.embedding MATCH ? AND k = ?
       ORDER BY distance
    `).all(buf, limit) as Array<{ contentId: number; body: string; distance: number; eventId: number | null }>;
    for (const r of vecRows) {
      if (r.eventId !== null) {
        vecHits.push({ eventId: r.eventId, contentId: r.contentId, body: r.body, score: 1 - r.distance, source: 'vec' });
      }
    }
  } catch {
    return lexHits;
  }

  if (mode === 'vec') return vecHits;

  const merged = new Map<number, RecallHit>();
  for (const h of [...lexHits, ...vecHits]) {
    const existing = merged.get(h.contentId);
    if (existing) merged.set(h.contentId, { ...existing, score: existing.score + h.score });
    else merged.set(h.contentId, h);
  }
  return Array.from(merged.values()).sort((a, b) => b.score - a.score).slice(0, limit);
}
