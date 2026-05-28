import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { closeDb, openDb } from '../memory/db.ts';
import { allMigrations, applyMigrations } from '../memory/migrations/index.ts';
import { ingestContentDocs } from './ingest-docs.ts';

/**
 * Temp user-data dir with a fresh DB and a couple of fixture docs under
 * content/knowledge/ and content/profile/ (including a nested sensitive subdir).
 * No live dispatcher — embedding is deferred to the embedder job, so a null
 * dispatcher exercises the full ingest path here.
 */
function fixtureRoot() {
  const dir = mkdtempSync(join(tmpdir(), 'robin-ingest-docs-'));
  mkdirSync(join(dir, 'state', 'db'), { recursive: true });
  const db = openDb(join(dir, 'state', 'db', 'robin.sqlite'));
  applyMigrations(db, allMigrations);
  return { db, dir };
}

function writeDoc(dir: string, rel: string, body: string) {
  const full = join(dir, rel);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, body);
  return full;
}

test('ingestContentDocs: first run ingests every doc, including sensitive subdirs', () => {
  const { db, dir } = fixtureRoot();
  writeDoc(dir, join('content', 'profile', 'character.md'), '# Character\nlikes coffee');
  writeDoc(dir, join('content', 'knowledge', 'projects.md'), '# Projects\nrobin, photo-tools');
  writeDoc(dir, join('content', 'knowledge', 'medical', 'meds.md'), '# Meds\ndaily vitamin');
  writeDoc(dir, join('content', 'knowledge', 'finance', 'accounts.md'), '# Accounts\nchecking');
  // Non-markdown is ignored.
  writeDoc(dir, join('content', 'knowledge', 'notes.txt'), 'not markdown');

  const r = ingestContentDocs(db, null, { userDataDir: dir });
  assert.equal(r.ingested, 4);
  assert.equal(r.skipped, 0);
  assert.equal(r.updated, 0);

  const rows = db
    .prepare(`SELECT COUNT(*) AS c FROM events WHERE kind = 'knowledge.doc' AND source = 'docs'`)
    .get() as { c: number };
  assert.equal(rows.c, 4, 'one event per markdown doc');

  // external_id is the POSIX relative path; body is stored verbatim in content.
  const ev = db
    .prepare(
      `SELECT json_extract(payload,'$.external_id') AS xid,
              json_extract(payload,'$.path') AS path,
              json_extract(payload,'$.sha') AS sha,
              c.body AS body
         FROM events e JOIN events_content c ON c.id = e.content_ref
        WHERE json_extract(e.payload,'$.path') = 'content/profile/character.md'`,
    )
    .get() as { xid: string; path: string; sha: string; body: string };
  assert.equal(ev.xid, 'doc:content/profile/character.md');
  assert.equal(ev.path, 'content/profile/character.md');
  assert.equal(ev.body, '# Character\nlikes coffee');
  assert.match(ev.sha, /^[0-9a-f]{64}$/);

  closeDb(db);
});

test('ingestContentDocs: second run with no changes skips everything', () => {
  const { db, dir } = fixtureRoot();
  writeDoc(dir, join('content', 'profile', 'character.md'), 'a');
  writeDoc(dir, join('content', 'knowledge', 'projects.md'), 'b');

  const first = ingestContentDocs(db, null, { userDataDir: dir });
  assert.equal(first.ingested, 2);

  const second = ingestContentDocs(db, null, { userDataDir: dir });
  assert.equal(second.ingested, 0);
  assert.equal(second.updated, 0);
  assert.equal(second.skipped, 2);

  const rows = db
    .prepare(`SELECT COUNT(*) AS c FROM events WHERE kind = 'knowledge.doc'`)
    .get() as { c: number };
  assert.equal(rows.c, 2, 'idempotent — no duplicate events');

  closeDb(db);
});

test('ingestContentDocs: a changed doc re-ingests in place and invalidates the embedding', () => {
  const { db, dir } = fixtureRoot();
  const path = writeDoc(dir, join('content', 'profile', 'character.md'), 'original');
  writeDoc(dir, join('content', 'knowledge', 'projects.md'), 'stable');

  const first = ingestContentDocs(db, null, { userDataDir: dir });
  assert.equal(first.ingested, 2);

  const evBefore = db
    .prepare(
      `SELECT id, content_ref FROM events
        WHERE json_extract(payload,'$.external_id') = 'doc:content/profile/character.md'`,
    )
    .get() as { id: number; content_ref: number };
  // Simulate the embedder having vectorized the row already.
  db.prepare(`UPDATE events_content SET embedding = ? WHERE id = ?`).run(
    Buffer.from(new Float32Array([1, 2, 3]).buffer),
    evBefore.content_ref,
  );

  writeFileSync(path, 'edited body');
  const second = ingestContentDocs(db, null, { userDataDir: dir });
  assert.equal(second.ingested, 0);
  assert.equal(second.updated, 1, 'only the changed doc re-ingests');
  assert.equal(second.skipped, 1, 'the untouched doc is skipped');

  // Updated in place (same event id), not appended.
  const evAfter = db
    .prepare(
      `SELECT id, content_ref FROM events
        WHERE json_extract(payload,'$.external_id') = 'doc:content/profile/character.md'`,
    )
    .get() as { id: number; content_ref: number };
  assert.equal(evAfter.id, evBefore.id);

  const content = db
    .prepare(`SELECT body, embedding FROM events_content WHERE id = ?`)
    .get(evAfter.content_ref) as { body: string; embedding: Buffer | null };
  assert.equal(content.body, 'edited body');
  assert.equal(content.embedding, null, 'changed doc must drop the stale embedding');

  const rows = db
    .prepare(`SELECT COUNT(*) AS c FROM events WHERE kind = 'knowledge.doc'`)
    .get() as { c: number };
  assert.equal(rows.c, 2, 'still one event per doc after update');

  closeDb(db);
});

test('ingestContentDocs: excluded paths are skipped', () => {
  const { db, dir } = fixtureRoot();
  writeDoc(dir, join('content', 'knowledge', 'good.md'), '# Good\nkeep this');
  writeDoc(dir, join('content', 'knowledge', 'imported-from-v1', 'tasks.md'), '# Stale\nold tasks');
  writeDoc(
    dir,
    join('content', 'knowledge', 'imported-from-v1', 'self-improvement', 'corrections.md'),
    '# Stale\nold corrections',
  );
  writeDoc(
    dir,
    join('content', 'knowledge', 'imported-from-v1', 'knowledge', 'finance', 'accounts.md'),
    '# OK\nlegit v1 data',
  );
  writeDoc(
    dir,
    join('content', 'knowledge', 'robin-operations', 'daily-brief-protocol.md'),
    '# Ops\nengineering doc',
  );
  writeDoc(
    dir,
    join('content', 'knowledge', 'robin-operations', 'kevin-preferences.md'),
    '# Prefs\npersonal prefs',
  );

  const r = ingestContentDocs(db, null, { userDataDir: dir });
  assert.equal(r.ingested, 3, 'good.md + v1/knowledge/finance/accounts.md + kevin-preferences.md');

  const paths = (
    db
      .prepare(
        `SELECT json_extract(payload,'$.path') AS path FROM events WHERE kind = 'knowledge.doc'`,
      )
      .all() as { path: string }[]
  ).map((r) => r.path);

  assert.ok(paths.includes('content/knowledge/good.md'));
  assert.ok(paths.includes('content/knowledge/imported-from-v1/knowledge/finance/accounts.md'));
  assert.ok(paths.includes('content/knowledge/robin-operations/kevin-preferences.md'));
  assert.ok(!paths.includes('content/knowledge/imported-from-v1/tasks.md'));
  assert.ok(!paths.includes('content/knowledge/imported-from-v1/self-improvement/corrections.md'));
  assert.ok(!paths.includes('content/knowledge/robin-operations/daily-brief-protocol.md'));

  closeDb(db);
});

test('ingestContentDocs: missing content dirs → zero work, no throw', () => {
  const { db, dir } = fixtureRoot();
  const r = ingestContentDocs(db, null, { userDataDir: dir });
  assert.deepEqual(r, { ingested: 0, skipped: 0, updated: 0 });
  closeDb(db);
});
