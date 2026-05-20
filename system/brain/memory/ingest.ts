import type { LLMDispatcher } from '../llm/dispatcher.ts';
import type { RobinDb } from './db.ts';

export interface IngestInput {
  kind: string;
  source: string;
  content?: string;
  payload?: Record<string, unknown>;
  actor?: string;
}

export interface IngestResult {
  eventId: number;
  contentId?: number;
}

/**
 * Persist an event + its content row. Embeddings are NOT computed inline — that's the
 * job of `embed-backfill` (runs every minute via the cognition scheduler), which picks
 * up content rows with `embedding IS NULL` and embeds them in batches.
 *
 * The earlier inline-embed path blocked every ingest on a ~600ms Ollama call. Fine for
 * a low-volume conversation event, painful for high-frequency integration ticks (a
 * lunch_money backfill of 5,000 transactions becomes 50 minutes of inline blocking).
 * Vector recall now lags new events by up to one batch interval (~60s), which is
 * invisible for personal-memory use — FTS5 keyword recall stays instant either way.
 *
 * The `llm` parameter is kept for API compatibility but is unused. If a caller genuinely
 * needs sync embedding (rare), they should compute the vector themselves and write it
 * directly to `events_content.embedding` + `events_vec` with the rowid-as-BigInt idiom.
 */
export function ingest(db: RobinDb, _llm: LLMDispatcher | null, input: IngestInput): IngestResult {
  let contentId: number | undefined;
  const eventId = db.transaction(() => {
    if (input.content) {
      const cInfo = db
        .prepare(`
        INSERT INTO events_content (ts, body) VALUES (?, ?)
      `)
        .run(new Date().toISOString(), input.content);
      contentId = Number(cInfo.lastInsertRowid);
    }
    const eInfo = db
      .prepare(`
      INSERT INTO events (ts, kind, source, actor, status, payload, content_ref)
      VALUES (?, ?, ?, ?, 'ok', ?, ?)
    `)
      .run(
        new Date().toISOString(),
        input.kind,
        input.source,
        input.actor ?? null,
        JSON.stringify(input.payload ?? {}),
        contentId ?? null,
      );
    return Number(eInfo.lastInsertRowid);
  })();

  return { eventId, contentId };
}
