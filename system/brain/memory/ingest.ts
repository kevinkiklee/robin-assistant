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
  /** True when an existing row with matching source + payload.external_id was updated in place. */
  upserted?: boolean;
}

/**
 * Persist an event + its content row. Embeddings are NOT computed inline — that's the
 * job of `embedder` (runs every minute via the cognition scheduler), which picks
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
  const ts = new Date().toISOString();
  const payload = input.payload ?? {};
  const externalId =
    typeof payload.external_id === 'string' && payload.external_id ? payload.external_id : null;

  const out: { eventId: number; contentId?: number; upserted: boolean } = db.transaction(() => {
    // Upsert path: when payload carries an external_id, look for a prior row
    // with the same (source, payload.external_id). If found, update content +
    // payload + ts in place rather than appending a duplicate. This makes
    // high-frequency integration ticks idempotent on per-record identity (LM
    // transactions, Spotify plays, NHL games, etc.) without a schema change.
    if (externalId) {
      const existing = db
        .prepare(`
        SELECT id, content_ref FROM events
        WHERE source = ? AND json_extract(payload, '$.external_id') = ?
        ORDER BY id DESC LIMIT 1
      `)
        .get(input.source, externalId) as { id: number; content_ref: number | null } | undefined;

      if (existing) {
        let contentRef: number | null = existing.content_ref;
        if (input.content) {
          if (contentRef != null) {
            db.prepare(
              `UPDATE events_content SET ts = ?, body = ?, embedding = NULL WHERE id = ?`,
            ).run(ts, input.content, contentRef);
            // Drop the stale embedding from the vec virtual table — the next embedder
            // tick will re-embed and re-insert. `events_vec` rowid mirrors content id.
            try {
              db.prepare(`DELETE FROM events_vec WHERE rowid = ?`).run(contentRef);
            } catch {
              // vec table not initialized in this env (tests); safe to ignore.
            }
          } else {
            const cInfo = db
              .prepare(`INSERT INTO events_content (ts, body) VALUES (?, ?)`)
              .run(ts, input.content);
            contentRef = Number(cInfo.lastInsertRowid);
          }
        }
        db.prepare(
          `UPDATE events SET ts = ?, kind = ?, actor = ?, status = 'ok', payload = ?, content_ref = ? WHERE id = ?`,
        ).run(
          ts,
          input.kind,
          input.actor ?? null,
          JSON.stringify(payload),
          contentRef,
          existing.id,
        );
        return { eventId: existing.id, contentId: contentRef ?? undefined, upserted: true };
      }
    }

    // Insert path: fresh row.
    let contentId: number | undefined;
    if (input.content) {
      const cInfo = db
        .prepare(`INSERT INTO events_content (ts, body) VALUES (?, ?)`)
        .run(ts, input.content);
      contentId = Number(cInfo.lastInsertRowid);
    }
    const eInfo = db
      .prepare(
        `INSERT INTO events (ts, kind, source, actor, status, payload, content_ref) VALUES (?, ?, ?, ?, 'ok', ?, ?)`,
      )
      .run(
        ts,
        input.kind,
        input.source,
        input.actor ?? null,
        JSON.stringify(payload),
        contentId ?? null,
      );
    return { eventId: Number(eInfo.lastInsertRowid), contentId, upserted: false };
  })();

  return { eventId: out.eventId, contentId: out.contentId, upserted: out.upserted };
}
