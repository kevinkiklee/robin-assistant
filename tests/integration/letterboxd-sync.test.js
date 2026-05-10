import assert from 'node:assert';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseDiaryCsv } from '../../src/integrations/letterboxd/csv.js';
import { sync } from '../../src/integrations/letterboxd/sync.js';

test('parseDiaryCsv handles standard Letterboxd Diary export', () => {
  const csv = `Date,Name,Year,Letterboxd URI,Rating,Rewatch,Tags,Watched Date
2026-04-01,The Apartment,1960,https://letterboxd.com/film/the-apartment/,4.5,Yes,classic,2026-03-30`;
  const rows = parseDiaryCsv(csv);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'The Apartment');
  assert.equal(rows[0].year, '1960');
  assert.equal(rows[0].rating, 4.5);
  assert.equal(rows[0].rewatch, true);
  assert.equal(rows[0].slug, 'the-apartment');
});

test('parseDiaryCsv rejects non-diary CSVs', () => {
  assert.throws(
    () => parseDiaryCsv('Foo,Bar\n1,2'),
    (e) => e.code === 'NOT_DIARY',
  );
});

test('letterboxd sync captures + moves CSV to processed/', async () => {
  const home = mkdtempSync(join(tmpdir(), 'robin-home-'));
  process.env.ROBIN_HOME = home;
  try {
    const upload = join(home, 'upload');
    mkdirSync(upload);
    writeFileSync(
      join(upload, 'letterboxd-diary.csv'),
      'Date,Name,Year,Letterboxd URI,Rating,Rewatch,Tags,Watched Date\n2026-04-01,Heat,1995,https://letterboxd.com/film/heat/,5,No,,2026-03-30\n',
    );
    const captured = [];
    const ctx = {
      capture: async (evs) => {
        captured.push(...evs);
        return { count: evs.length };
      },
      log: () => {},
    };
    const out = await sync(ctx);
    assert.equal(out.count, 1);
    assert.equal(captured[0].meta.kind, 'letterboxd_diary');
    assert.equal(captured[0].external_id, 'letterboxd:diary:2026-03-30:heat');
    assert.ok(existsSync(join(upload, 'processed', 'letterboxd-diary.csv')));
  } finally {
    process.env.ROBIN_HOME = undefined;
  }
});

test('letterboxd sync no-op when no CSVs', async () => {
  const home = mkdtempSync(join(tmpdir(), 'robin-home-empty-'));
  process.env.ROBIN_HOME = home;
  try {
    mkdirSync(join(home, 'upload'));
    const ctx = { capture: async () => ({ count: 0 }), log: () => {} };
    const out = await sync(ctx);
    assert.equal(out.count, 0);
  } finally {
    process.env.ROBIN_HOME = undefined;
  }
});

test('letterboxd sync moves non-diary CSV aside', async () => {
  const home = mkdtempSync(join(tmpdir(), 'robin-home-bad-'));
  process.env.ROBIN_HOME = home;
  try {
    const upload = join(home, 'upload');
    mkdirSync(upload);
    writeFileSync(join(upload, 'letterboxd-reviews.csv'), 'Foo,Bar\n1,2\n');
    const ctx = { capture: async () => ({ count: 0 }), log: () => {} };
    await sync(ctx);
    assert.ok(existsSync(join(upload, 'processed', 'letterboxd-reviews.csv.unrecognized')));
    assert.ok(
      existsSync(join(upload, 'processed', 'letterboxd-reviews.csv.unrecognized.error.txt')),
    );
  } finally {
    process.env.ROBIN_HOME = undefined;
  }
});
