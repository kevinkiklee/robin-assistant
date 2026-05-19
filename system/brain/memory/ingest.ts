import type { RobinDb } from './db.ts';
import type { LLMDispatcher } from '../llm/dispatcher.ts';

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
      const cInfo = db.prepare(`
        INSERT INTO events_content (ts, body) VALUES (?, ?)
      `).run(new Date().toISOString(), input.content);
      contentId = Number(cInfo.lastInsertRowid);
    }
    const eInfo = db.prepare(`
      INSERT INTO events (ts, kind, source, actor, status, payload, content_ref)
      VALUES (?, ?, ?, ?, 'ok', ?, ?)
    `).run(
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
      const [vec] = await llm.embed('embed', input.content);
      const buf = Buffer.from(new Float32Array(vec).buffer);
      db.transaction(() => {
        db.prepare(`UPDATE events_content SET embedding = ? WHERE id = ?`).run(buf, contentId);
        // Note: vec0 virtual table auto-assigns rowid, don't specify it explicitly
        db.prepare(`INSERT INTO events_vec(embedding) VALUES (?)`).run(buf);
      })();
      embedded = true;
    } catch (err) {
      embedError = err instanceof Error ? err.message : String(err);
    }
  }
  return { eventId, contentId, embedded, embedError };
}
