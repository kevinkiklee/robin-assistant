import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { closeDb, openDb, type RobinDb } from '../memory/db.ts';
import { ingest } from '../memory/ingest.ts';
import { allMigrations, applyMigrations } from '../memory/migrations/index.ts';
import { recall } from '../memory/recall.ts';
import { quantizeToInt8Json } from '../memory/vec-quantize.ts';
import { excludedPrefixes, ingestContentDocs, pruneDocEvents } from './ingest-docs.ts';

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

test('ingestContentDocs: first run ingests every doc, including nested subdirs', () => {
  const { db, dir } = fixtureRoot();
  writeDoc(dir, join('content', 'profile', 'character.md'), '# Character\nlikes coffee');
  writeDoc(dir, join('content', 'knowledge', 'projects.md'), '# Projects\nrobin, widget-kit');
  writeDoc(dir, join('content', 'knowledge', 'docs', 'recipes.md'), '# Recipes\nweeknight soup');
  writeDoc(dir, join('content', 'knowledge', 'docs', 'knitting-patterns.md'), '# Patterns\nraglan');
  // Other file types are ignored.
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

test('ingestContentDocs: unchanged mtime + size skips on a stat alone (file is never read)', () => {
  const { db, dir } = fixtureRoot();
  const file = writeDoc(dir, join('content', 'knowledge', 'projects.md'), '# Projects\nrobin');
  assert.equal(ingestContentDocs(db, null, { userDataDir: dir }).ingested, 1);
  // Unreadable now: a read would throw, so passing proves the fast path never reads.
  chmodSync(file, 0o000);
  try {
    const r = ingestContentDocs(db, null, { userDataDir: dir });
    assert.deepEqual(r, { ingested: 0, skipped: 1, updated: 0 });
  } finally {
    chmodSync(file, 0o644);
    closeDb(db);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ingestContentDocs: touched but identical body → hashed, skipped, stored stat refreshed', () => {
  const { db, dir } = fixtureRoot();
  const file = writeDoc(dir, join('content', 'knowledge', 'projects.md'), '# Projects\nrobin');
  ingestContentDocs(db, null, { userDataDir: dir });
  const later = new Date(Date.now() + 60_000);
  utimesSync(file, later, later);

  const r = ingestContentDocs(db, null, { userDataDir: dir });
  assert.deepEqual(r, { ingested: 0, skipped: 1, updated: 0 }, 'same sha → no re-ingest');
  const payload = JSON.parse(
    (
      db.prepare(`SELECT payload FROM events WHERE kind = 'knowledge.doc'`).get() as {
        payload: string;
      }
    ).payload,
  ) as { mtime: number; size: number };
  assert.ok(
    Math.abs(payload.mtime - statSync(file).mtimeMs) < 1,
    'stat refreshed for the next fast-path skip',
  );
  assert.equal(payload.size, statSync(file).size);
  closeDb(db);
  rmSync(dir, { recursive: true, force: true });
});

test('ingestContentDocs: a legacy event without size is hashed once, then fast-pathed', () => {
  const { db, dir } = fixtureRoot();
  const file = writeDoc(dir, join('content', 'knowledge', 'projects.md'), '# Projects\nrobin');
  ingestContentDocs(db, null, { userDataDir: dir });
  db.prepare(`UPDATE events SET payload = json_remove(payload, '$.size')`).run();

  assert.equal(ingestContentDocs(db, null, { userDataDir: dir }).skipped, 1);
  chmodSync(file, 0o000);
  try {
    assert.equal(ingestContentDocs(db, null, { userDataDir: dir }).skipped, 1);
  } finally {
    chmodSync(file, 0o644);
    closeDb(db);
    rmSync(dir, { recursive: true, force: true });
  }
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
  // The operator's exclusions live in user-data/config/ingest-docs.yaml, not in code.
  writeDoc(
    dir,
    join('config', 'ingest-docs.yaml'),
    'exclude:\n  - content/knowledge/old/notes.md\n  - content/knowledge/old/scratch/\n  - content/knowledge/ops/runbook.md\n',
  );
  writeDoc(dir, join('content', 'knowledge', 'good.md'), '# Good\nkeep this');
  writeDoc(dir, join('content', 'knowledge', 'old', 'notes.md'), '# Stale\nold notes');
  writeDoc(dir, join('content', 'knowledge', 'old', 'scratch', 'drafts.md'), '# Stale\nold drafts');
  writeDoc(
    dir,
    join('content', 'knowledge', 'old', 'kept', 'pie-crust.md'),
    '# OK\nstill-useful old doc',
  );
  writeDoc(dir, join('content', 'knowledge', 'ops', 'runbook.md'), '# Ops\nengineering doc');
  writeDoc(
    dir,
    join('content', 'knowledge', 'ops', 'supply-list.md'),
    '# Supplies\nstaples and sticky notes',
  );

  const r = ingestContentDocs(db, null, { userDataDir: dir });
  assert.equal(r.ingested, 3, 'good.md + old/kept/pie-crust.md + ops/supply-list.md');

  const paths = (
    db
      .prepare(
        `SELECT json_extract(payload,'$.path') AS path FROM events WHERE kind = 'knowledge.doc'`,
      )
      .all() as { path: string }[]
  ).map((r) => r.path);

  assert.ok(paths.includes('content/knowledge/good.md'));
  assert.ok(paths.includes('content/knowledge/old/kept/pie-crust.md'));
  assert.ok(paths.includes('content/knowledge/ops/supply-list.md'));
  assert.ok(!paths.includes('content/knowledge/old/notes.md'));
  assert.ok(!paths.includes('content/knowledge/old/scratch/drafts.md'));
  assert.ok(!paths.includes('content/knowledge/ops/runbook.md'));

  closeDb(db);
});

test('ingestContentDocs: profile/writing exemplar banks are excluded, voice.md is not', () => {
  const { db, dir } = fixtureRoot();
  writeDoc(dir, join('content', 'profile', 'voice.md'), '# Voice\nhow robin talks to sam');
  writeDoc(dir, join('content', 'profile', 'writing', 'x.md'), '> raw personal exemplar text');

  const r = ingestContentDocs(db, null, { userDataDir: dir });
  assert.equal(r.ingested, 1, 'only voice.md — exemplar banks must not enter the knowledge graph');

  const paths = (
    db
      .prepare(
        `SELECT json_extract(payload,'$.path') AS path FROM events WHERE kind = 'knowledge.doc'`,
      )
      .all() as { path: string }[]
  ).map((r) => r.path);

  assert.ok(paths.includes('content/profile/voice.md'));
  assert.ok(!paths.some((p) => p.startsWith('content/profile/writing/')));

  closeDb(db);
});

test('ingestContentDocs: missing content dirs → zero work, no throw', () => {
  const { db, dir } = fixtureRoot();
  const r = ingestContentDocs(db, null, { userDataDir: dir });
  assert.deepEqual(r, { ingested: 0, skipped: 0, updated: 0 });
  closeDb(db);
});

/** The doc event row for a relative path, or undefined once pruned. */
function docRow(db: RobinDb, path: string) {
  return db
    .prepare(
      `SELECT id, content_ref FROM events
        WHERE kind = 'knowledge.doc' AND source = 'docs'
          AND json_extract(payload,'$.path') = ?`,
    )
    .get(path) as { id: number; content_ref: number } | undefined;
}

function countRows(db: RobinDb, sql: string, ...params: unknown[]): number {
  return (db.prepare(sql).get(...params) as { n: number }).n;
}

test('pruneDocEvents: a deleted doc leaves the index — event, content, vec, and lex', async () => {
  const { db, dir } = fixtureRoot();
  writeDoc(dir, join('content', 'knowledge', 'keep.md'), '# Keep\nheliotrope stays indexed');
  const deadFile = writeDoc(dir, join('content', 'knowledge', 'dead.md'), '# Dead\nxylophone doc');
  ingestContentDocs(db, null, { userDataDir: dir });

  const dead = docRow(db, 'content/knowledge/dead.md');
  assert.ok(dead, 'fixture doc must be indexed before the prune');
  // Simulate the embedder having vectorized the doomed doc: sentinel in
  // events_content.embedding + an int8 vec0 index row (prune-noise.test idiom).
  db.prepare(`UPDATE events_content SET embedding = ? WHERE id = ?`).run(
    Buffer.from([1]),
    dead.content_ref,
  );
  db.prepare(`INSERT INTO events_vec(rowid, embedding) VALUES (?, vec_int8(?))`).run(
    BigInt(dead.content_ref),
    quantizeToInt8Json(new Array(3072).fill(0.05)),
  );

  // Reachable via lex recall before the file goes away.
  const before = await recall(db, null, 'xylophone');
  assert.ok(
    before.some((h) => h.eventId === dead.id),
    'doc must be lex-recallable pre-prune',
  );

  rmSync(deadFile);
  const r = pruneDocEvents(db, { userDataDir: dir });
  assert.equal(r.pruned, 1);

  assert.equal(countRows(db, `SELECT count(*) AS n FROM events WHERE id = ?`, dead.id), 0);
  assert.equal(
    countRows(db, `SELECT count(*) AS n FROM events_content WHERE id = ?`, dead.content_ref),
    0,
  );
  assert.equal(
    countRows(db, `SELECT count(*) AS n FROM events_vec WHERE rowid = ?`, dead.content_ref),
    0,
  );
  // events_content_fts is external-content, synced by the events_content_ad
  // trigger — the content DELETE must have removed the row from the lex index.
  assert.equal(
    countRows(
      db,
      `SELECT count(*) AS n FROM events_content_fts WHERE events_content_fts MATCH 'xylophone'`,
    ),
    0,
  );
  const after = await recall(db, null, 'xylophone');
  assert.equal(after.length, 0, 'pruned doc must not be lex-recallable');

  // The live doc is untouched and still recallable.
  assert.ok(docRow(db, 'content/knowledge/keep.md'));
  const keep = await recall(db, null, 'heliotrope');
  assert.equal(keep.length, 1);

  // Idempotent: a second run finds nothing left to prune.
  assert.equal(pruneDocEvents(db, { userDataDir: dir }).pruned, 0);
  closeDb(db);
});

test('pruneDocEvents: a legacy event under an excluded prefix is pruned even when the file exists', () => {
  const { db, dir } = fixtureRoot();
  // The operator's exclusions live in user-data/config/ingest-docs.yaml, not in code.
  writeDoc(
    dir,
    join('config', 'ingest-docs.yaml'),
    'exclude:\n  - content/knowledge/old/notes.md\n  - content/knowledge/old/scratch/\n  - content/knowledge/ops/runbook.md\n',
  );
  writeDoc(dir, join('content', 'knowledge', 'good.md'), '# Good\nlive doc');
  // The file exists on disk but its prefix is excluded — simulate an event
  // written BEFORE the prefix was excluded (exclusion only stops
  // future ingestion, so the stale event would otherwise sit in the index forever).
  writeDoc(dir, join('content', 'knowledge', 'old', 'notes.md'), '# Stale\nold notes');
  ingest(db, null, {
    kind: 'knowledge.doc',
    source: 'docs',
    content: '# Stale\nold notes',
    payload: {
      external_id: 'doc:content/knowledge/old/notes.md',
      path: 'content/knowledge/old/notes.md',
    },
  });
  ingestContentDocs(db, null, { userDataDir: dir });
  // A non-doc event is never pruned, whatever its payload path looks like.
  const other = ingest(db, null, {
    kind: 'session.captured',
    source: 'capture',
    content: 'unrelated session text',
    payload: { path: 'content/knowledge/old/notes.md' },
  });

  const r = pruneDocEvents(db, { userDataDir: dir });
  assert.equal(r.pruned, 1);

  const paths = (
    db
      .prepare(
        `SELECT json_extract(payload,'$.path') AS path FROM events WHERE kind = 'knowledge.doc'`,
      )
      .all() as { path: string }[]
  ).map((row) => row.path);
  assert.deepEqual(paths, ['content/knowledge/good.md']);
  assert.equal(countRows(db, `SELECT count(*) AS n FROM events WHERE id = ?`, other.eventId), 1);
  closeDb(db);
});

test('pruneDocEvents: live docs are untouched — prunes 0', () => {
  const { db, dir } = fixtureRoot();
  writeDoc(dir, join('content', 'profile', 'character.md'), '# Character\nsteady');
  writeDoc(dir, join('content', 'knowledge', 'projects.md'), '# Projects\nrobin');
  ingestContentDocs(db, null, { userDataDir: dir });

  const r = pruneDocEvents(db, { userDataDir: dir });
  assert.equal(r.pruned, 0);
  assert.equal(countRows(db, `SELECT count(*) AS n FROM events WHERE kind = 'knowledge.doc'`), 2);
  closeDb(db);
});

test('ingestContentDocs: .html docs are indexed as visible text, not markup', () => {
  const { db, dir } = fixtureRoot();
  writeDoc(
    dir,
    join('content', 'knowledge', 'travel', 'trip.html'),
    '<!doctype html><html><head><title>Lake Trip</title><meta name="description" content="Four nights.">' +
      '<style>.x{color:red}</style></head><body><h1>Plan</h1>' +
      '<table><tr><td>Mon 03/09</td><td>Lakeport</td></tr></table><script>evil()</script></body></html>',
  );

  const r = ingestContentDocs(db, null, { userDataDir: dir });
  assert.equal(r.ingested, 1);
  const ev = db
    .prepare(
      `SELECT c.body AS body, json_extract(e.payload,'$.path') AS path
         FROM events e JOIN events_content c ON c.id = e.content_ref`,
    )
    .get() as { body: string; path: string };
  assert.equal(ev.path, 'content/knowledge/travel/trip.html');
  assert.match(ev.body, /^# Lake Trip\nFour nights\./);
  assert.match(ev.body, /# Plan/);
  assert.match(ev.body, /Mon 03\/09 \| Lakeport/);
  assert.ok(!/color:red|evil\(\)|<td>/.test(ev.body), 'no css, script, or tags');
  closeDb(db);
});

test('excludedPrefixes: the voice exemplars are always out; the rest comes from user-data config', () => {
  const { dir } = fixtureRoot();
  assert.deepEqual(
    excludedPrefixes(dir),
    ['content/profile/writing/'],
    'no config → built-in only',
  );
  writeDoc(
    dir,
    join('config', 'ingest-docs.yaml'),
    'exclude:\n  - content/knowledge/old/\n  - ""\n',
  );
  assert.deepEqual(excludedPrefixes(dir), ['content/profile/writing/', 'content/knowledge/old/']);
});
