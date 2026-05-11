import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { sync } from '../../src/integrations/lrc/sync.js';

let tmpHome;
let catalogPath;

test.beforeEach(() => {
  tmpHome = join(tmpdir(), `robin-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpHome, { recursive: true });
  process.env.ROBIN_HOME = tmpHome;
  catalogPath = join(tmpHome, 'fixture.lrcat');
  process.env.LRC_CATALOG_PATH = catalogPath;
  // Build a minimal Lightroom-like schema.
  const db = new Database(catalogPath);
  db.exec(`
    CREATE TABLE Adobe_images (
      id_local INTEGER PRIMARY KEY,
      captureTime TEXT,
      rating INTEGER,
      rootFolder INTEGER
    );
    CREATE TABLE AgLibraryFolder (
      id_local INTEGER PRIMARY KEY,
      pathFromRoot TEXT
    );
  `);
  db.prepare('INSERT INTO AgLibraryFolder (id_local, pathFromRoot) VALUES (?, ?)').run(
    1,
    '2026/05/',
  );
  db.prepare(
    'INSERT INTO Adobe_images (id_local, captureTime, rating, rootFolder) VALUES (?, ?, ?, ?)',
  ).run(1, '2026-05-09T10:00:00', 5, 1);
  db.prepare(
    'INSERT INTO Adobe_images (id_local, captureTime, rating, rootFolder) VALUES (?, ?, ?, ?)',
  ).run(2, '2026-05-10T10:00:00', 4, 1);
  db.close();
});

test.afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
  delete process.env.LRC_CATALOG_PATH;
  delete process.env.ROBIN_HOME;
});

test('lrc sync produces summary event', async () => {
  const captured = [];
  const r = await sync({
    secrets: {},
    log: () => {},
    cursor: null,
    capture: async (rows) => {
      captured.push(...rows);
      return {};
    },
  });
  assert.equal(r.count, 1);
  assert.equal(captured[0].source, 'lrc');
  assert.match(captured[0].content, /2 photos/);
  assert.equal(captured[0].meta.total_photos, 2);
});

test('lrc sync throws when LRC_CATALOG_PATH unset', async () => {
  delete process.env.LRC_CATALOG_PATH;
  await assert.rejects(
    () =>
      sync({
        secrets: {},
        log: () => {},
        cursor: null,
        capture: async () => ({}),
      }),
    /LRC_CATALOG_PATH/,
  );
});
