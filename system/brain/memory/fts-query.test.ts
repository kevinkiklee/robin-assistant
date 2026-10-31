import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { closeDb, openDb } from './db.ts';
import { buildFtsQuery, contentTerms, MAX_FTS_TERMS } from './fts-query.ts';
import { ingest } from './ingest.ts';
import { allMigrations, applyMigrations } from './migrations/index.ts';

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'robin-fts-query-'));
  mkdirSync(join(dir, 'state', 'db'), { recursive: true });
  const db = openDb(join(dir, 'state', 'db', 'robin.sqlite'));
  applyMigrations(db, allMigrations);
  return db;
}

test('contentTerms: drops stopwords, contraction fragments, dupes; keeps digit tokens', () => {
  assert.deepEqual(contentTerms("is it the Fern Scarf? I'd say it's not the fern one!"), [
    'fern',
    'scarf',
  ]);
  assert.deepEqual(contentTerms('Q3 vs Q4: which deck? q3 again'), ['q3', 'q4', 'deck']);
  assert.deepEqual(contentTerms('ok sounds good, do that'), []);
});

test('contentTerms: caps the term count', () => {
  const many = Array.from({ length: 60 }, (_, i) => `term${i}word`).join(' ');
  assert.equal(contentTerms(many).length, MAX_FTS_TERMS);
});

test('buildFtsQuery: quotes every term; all = implicit AND, any = OR; empty on no terms', () => {
  assert.equal(buildFtsQuery('muffin tray is empty'), '"muffin" "tray" "empty"');
  assert.equal(buildFtsQuery('muffin tray is empty', 'any'), '"muffin" OR "tray" OR "empty"');
  assert.equal(buildFtsQuery('proceed AND NEAR'), '"proceed" "near"');
  assert.equal(buildFtsQuery('is it ok?'), '');
});

test('buildFtsQuery: real prompt shapes that crashed FTS5 now parse and match', () => {
  const db = freshDb();
  ingest(db, null, {
    kind: 'belief.update',
    source: 's',
    content: 'Batch notes: oatmeal cookies get chocolate chips, never raisins',
  });
  const prompts = [
    "Can we swap the raisins? Sam's not a fan.",
    'is this the right tray [Image #1] for the cookies?',
    'recipe card below <pasted_content id="x2"> oatmeal',
    'step/notes — cookies, chips; "quoted" ^caret* (paren)',
  ];
  for (const p of prompts) {
    const q = buildFtsQuery(p, 'any');
    assert.ok(q, `expected terms for ${p}`);
    const rows = db
      .prepare('SELECT rowid FROM events_content_fts WHERE events_content_fts MATCH ?')
      .all(q);
    assert.equal(rows.length, 1, `expected one match for ${JSON.stringify(p)}`);
  }
  closeDb(db);
});
