import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { compactCapturedSessions, compactTranscript } from './compact-sessions.ts';
import { closeDb, openDb } from './db.ts';
import { ingest } from './ingest.ts';
import { allMigrations, applyMigrations } from './migrations/index.ts';

function freshDb() {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'robin-compact-')), 'robin.sqlite'));
  applyMigrations(db, allMigrations);
  return db;
}

const TRANSCRIPT = [
  '[USER]\n<system-reminder>\nnoise\n</system-reminder>\n\n[USER]\nhow is the v2 data migration going',
  '[ASSISTANT]\nI will investigate the current state of the migration.',
  '[USER]\nkeep going',
  '[ASSISTANT]\nDone — a very long explanation follows here.',
].join('\n\n');

test('compactTranscript keeps user turns, drops assistant turns and reminders', () => {
  const out = compactTranscript(TRANSCRIPT);
  assert.match(out, /how is the v2 data migration going/);
  assert.match(out, /keep going/);
  assert.doesNotMatch(out, /ASSISTANT|investigate|noise/);
});

function seedSession(db: ReturnType<typeof freshDb>, ts: string, extracted: boolean, n: number) {
  const r = ingest(db, null, {
    kind: 'session.captured',
    source: 'claude_code',
    content: TRANSCRIPT,
    payload: { sessionId: `s${n}`, external_id: `cap:${n}` },
  }) as { eventId?: number; id?: number };
  const id = (r.eventId ?? r.id) as number;
  db.prepare(`UPDATE events SET ts = ? WHERE id = ?`).run(ts, id);
  if (extracted) {
    db.prepare(
      `INSERT INTO events (ts, kind, source, status, payload) VALUES (?, 'biographer.extracted', 'biographer', 'ok', ?)`,
    ).run(ts, JSON.stringify({ source_event_id: id }));
  }
  return id;
}

test('compactCapturedSessions: only old, already-extracted sessions; dry-run writes nothing; idempotent', () => {
  const db = freshDb();
  const now = new Date('2026-10-03T00:00:00Z');
  seedSession(db, '2026-05-01T00:00:00Z', true, 1); // old + extracted → compacted
  seedSession(db, '2026-05-01T00:00:00Z', false, 2); // old, never extracted → kept
  seedSession(db, '2026-09-30T00:00:00Z', true, 3); // recent → kept
  const dry = compactCapturedSessions(db, { now });
  assert.equal(dry.sessions, 1);
  const bodies = () =>
    (
      db
        .prepare(
          `SELECT c.body AS b FROM events e JOIN events_content c ON c.id = e.content_ref WHERE e.kind='session.captured' ORDER BY e.id`,
        )
        .all() as Array<{ b: string }>
    ).map((r) => r.b);
  assert.ok(
    bodies().every((b) => b.includes('ASSISTANT')),
    'dry run changed nothing',
  );
  compactCapturedSessions(db, { now, apply: true });
  const after = bodies();
  assert.doesNotMatch(after[0], /ASSISTANT/);
  assert.match(after[1], /ASSISTANT/);
  assert.match(after[2], /ASSISTANT/);
  assert.equal(compactCapturedSessions(db, { now, apply: true }).sessions, 0, 'idempotent');
  closeDb(db);
});
