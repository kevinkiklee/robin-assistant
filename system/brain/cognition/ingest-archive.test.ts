import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { RobinDb } from '../memory/db.ts';
import { closeDb, openDb } from '../memory/db.ts';
import { allMigrations, applyMigrations } from '../memory/migrations/index.ts';
import { chunkText, ingestArchive } from './ingest-archive.ts';

describe('chunkText', () => {
  it('returns a single chunk when under the limit', () => {
    assert.deepEqual(chunkText('hello world', 4000), ['hello world']);
  });

  it('splits large text on paragraph boundaries, each within the limit', () => {
    const para = 'x'.repeat(100);
    const text = Array.from({ length: 60 }, () => para).join('\n\n');
    const chunks = chunkText(text, 1000);
    assert.ok(chunks.length > 1, 'expected multiple chunks');
    for (const c of chunks) assert.ok(c.length <= 1000, `chunk too long: ${c.length}`);
    // every paragraph survives the round-trip
    assert.equal(chunks.join('\n\n').split(para).length - 1, 60);
  });

  it('hard-splits a single oversized paragraph', () => {
    const chunks = chunkText('y'.repeat(2500), 1000);
    assert.ok(chunks.length >= 3, `expected >=3, got ${chunks.length}`);
    for (const c of chunks) assert.ok(c.length <= 1000);
  });
});

describe('ingestArchive', () => {
  let dir: string;
  let db: RobinDb;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'robin-archive-'));
    db = openDb(join(dir, 'test.db'));
    applyMigrations(db, allMigrations);
  });

  afterEach(() => {
    closeDb(db);
    rmSync(dir, { recursive: true, force: true });
  });

  function countArchive(source: string): number {
    return (
      db
        .prepare(`SELECT COUNT(*) AS c FROM events WHERE kind = 'knowledge.archive' AND source = ?`)
        .get(source) as { c: number }
    ).c;
  }

  it('ingests text files as knowledge.archive events', () => {
    const src = join(dir, 'src');
    mkdirSync(src);
    writeFileSync(join(src, 'a.md'), '# A\n\nalpha content');
    writeFileSync(join(src, 'b.txt'), 'beta content');
    const r = ingestArchive(db, null, { dir: src, source: 'blog' });
    assert.equal(r.files, 2);
    assert.equal(r.chunksIngested, 2);
    assert.equal(countArchive('blog'), 2);
  });

  it('is idempotent: rerun with no changes skips everything', () => {
    const src = join(dir, 'src');
    mkdirSync(src);
    writeFileSync(join(src, 'a.md'), 'alpha');
    ingestArchive(db, null, { dir: src, source: 'blog' });
    const r2 = ingestArchive(db, null, { dir: src, source: 'blog' });
    assert.equal(r2.chunksSkipped, 1);
    assert.equal(r2.chunksIngested, 0);
    assert.equal(countArchive('blog'), 1);
  });

  it('updates a changed file in place (upsert, no duplicate)', () => {
    const src = join(dir, 'src');
    mkdirSync(src);
    const f = join(src, 'a.md');
    writeFileSync(f, 'alpha');
    ingestArchive(db, null, { dir: src, source: 'blog' });
    writeFileSync(f, 'alpha revised');
    const r2 = ingestArchive(db, null, { dir: src, source: 'blog' });
    assert.equal(r2.chunksUpdated, 1);
    assert.equal(countArchive('blog'), 1);
  });

  it('ignores non-text extensions and the processed/ subdir', () => {
    const src = join(dir, 'src');
    mkdirSync(src);
    writeFileSync(join(src, 'keep.md'), 'keep');
    writeFileSync(join(src, 'skip.png'), 'binary');
    mkdirSync(join(src, 'processed'));
    writeFileSync(join(src, 'processed', 'old.md'), 'old');
    const r = ingestArchive(db, null, { dir: src, source: 'blog' });
    assert.equal(r.files, 1);
    assert.equal(countArchive('blog'), 1);
  });
});
