import { clockDate } from '../../lib/clock.ts';
import type { RobinDb } from './db.ts';

/** Sessions older than this are compacted (Claude Code itself deletes transcripts after ~30 days). */
export const COMPACT_AFTER_DAYS = 90;

export interface CompactResult {
  sessions: number;
  bytesBefore: number;
  bytesAfter: number;
}

/**
 * Keep the operator's own words, drop the bulk: a captured session's body is the full
 * transcript (`[USER]` / `[ASSISTANT]` turns). Assistant text is ~half of it and
 * is never what recall or the biographer needs from an old session; harness
 * `<system-reminder>` blocks pad the user turns. Compacted sessions keep every
 * user turn, minus those blocks, with a marker line.
 *
 * Only sessions the biographer has already extracted from are touched, so no
 * extraction input is lost. Idempotent (the marker is skipped on re-runs). The
 * FTS row follows via the events_content update trigger; the vector row is left
 * as is (it was embedded from the full text and still points at this content).
 */
export function compactCapturedSessions(
  db: RobinDb,
  opts: { apply?: boolean; now?: Date; olderThanDays?: number } = {},
): CompactResult {
  const now = opts.now ?? clockDate();
  const cutoff = new Date(now.getTime() - (opts.olderThanDays ?? COMPACT_AFTER_DAYS) * 86_400_000);
  const rows = db
    .prepare(
      `SELECT c.id AS id, c.body AS body FROM events e JOIN events_content c ON c.id = e.content_ref
        WHERE e.kind = 'session.captured' AND e.ts < ?
          AND EXISTS (SELECT 1 FROM events b WHERE b.kind = 'biographer.extracted'
                       AND json_extract(b.payload, '$.source_event_id') = e.id)`,
    )
    .all(cutoff.toISOString()) as Array<{ id: number; body: string | Buffer }>;

  const result: CompactResult = { sessions: 0, bytesBefore: 0, bytesAfter: 0 };
  const update = db.prepare(`UPDATE events_content SET body = ? WHERE id = ?`);
  const apply = db.transaction((changes: Array<[number, string]>) => {
    for (const [id, body] of changes) update.run(body, id);
  });
  const changes: Array<[number, string]> = [];
  for (const r of rows) {
    const body = typeof r.body === 'string' ? r.body : r.body.toString('utf8');
    if (body.startsWith(COMPACT_MARKER)) continue;
    const compacted = compactTranscript(body);
    if (compacted.length >= body.length) continue;
    result.sessions++;
    result.bytesBefore += body.length;
    result.bytesAfter += compacted.length;
    changes.push([r.id, compacted]);
  }
  if (opts.apply && changes.length > 0) apply(changes);
  return result;
}

const COMPACT_MARKER = '[compacted: assistant turns and system reminders removed]';

/** Exported for tests: user turns only, harness reminders stripped. */
export function compactTranscript(body: string): string {
  const parts = body.split(/\n?\[(USER|ASSISTANT)\]\n?/);
  const kept: string[] = [];
  for (let i = 1; i < parts.length - 1; i += 2) {
    if (parts[i] !== 'USER') continue;
    const text = parts[i + 1].replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
    if (text) kept.push(`[USER]\n${text}`);
  }
  return [COMPACT_MARKER, ...kept].join('\n\n');
}
