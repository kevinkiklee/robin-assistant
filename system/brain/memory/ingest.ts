import type { LLMDispatcher } from '../llm/dispatcher.ts';
import type { RobinDb } from './db.ts';
import { embedBody } from './embed-content.ts';

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
  embedded: boolean;
  embedError?: string;
}

export async function ingest(
  db: RobinDb,
  llm: LLMDispatcher | null,
  input: IngestInput,
): Promise<IngestResult> {
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

  let embedded = false;
  let embedError: string | undefined;
  if (input.content && contentId !== undefined && llm) {
    try {
      const vec = await embedBody(llm, input.content);
      const buf = Buffer.from(new Float32Array(vec).buffer);
      db.transaction(() => {
        db.prepare(`UPDATE events_content SET embedding = ? WHERE id = ?`).run(buf, contentId);
        // events_vec.rowid must equal events_content.id — recall.ts JOINs on that. Auto-assigned
        // rowids only happen to line up when every content insert is paired with a successful
        // embed, in order; any embed failure (or a reindex pass) breaks the invariant.
        // Bind as BigInt: sqlite-vec rejects JS Number for vec0 rowids with "only integers
        // allowed" (better-sqlite3 binds Number as REAL affinity by default; BigInt forces INTEGER).
        db.prepare(`INSERT INTO events_vec(rowid, embedding) VALUES (?, ?)`).run(
          BigInt(contentId as number),
          buf,
        );
      })();
      embedded = true;
    } catch (err) {
      embedError = err instanceof Error ? err.message : String(err);
    }
  }
  return { eventId, contentId, embedded, embedError };
}
