import assert from 'node:assert/strict';
import { mkdirSync as __robinMkdirSync } from 'node:fs';
import { tmpdir as __robinTmpdir } from 'node:os';
import { join as __robinJoin, resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { writeConfig as __robinWriteConfig } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';
import { createPhotosRecentTool } from '../../io/integrations/photos/tools/photos-recent.js';

const __robinTestHome = __robinJoin(
  __robinTmpdir(),
  `robin-test-${process.pid}-${Math.random().toString(36).slice(2)}`,
);
__robinMkdirSync(__robinTestHome, { recursive: true });
process.env.ROBIN_HOME = __robinTestHome;
await __robinWriteConfig({ embedder_profile: 'mxbai-1024' });

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../data/db/migrations'));
  return db;
}

async function seedPhoto(db, { path, mtimeMs, camera = 'Canon R5', category = 'birds' }) {
  await db
    .query(
      surql`CREATE events CONTENT ${{
        source: 'photos',
        content: `${path} · ${camera}`,
        ts: new Date(mtimeMs),
        meta: { path, category, camera, mtime_ms: mtimeMs },
      }}`,
    )
    .collect();
}

test('photos_recent returns N newest photos by ts DESC', async () => {
  const db = await fresh();
  const base = Date.parse('2026-05-10T12:00:00Z');
  await seedPhoto(db, { path: 'birds/a.jpg', mtimeMs: base });
  await seedPhoto(db, { path: 'birds/b.jpg', mtimeMs: base + 60_000 });
  await seedPhoto(db, { path: 'city/c.jpg', mtimeMs: base + 120_000 });
  const t = createPhotosRecentTool({ db });
  const r = await t.handler({ limit: 2 });
  assert.equal(r.photos.length, 2);
  assert.equal(r.photos[0].meta.path, 'city/c.jpg');
  assert.equal(r.photos[1].meta.path, 'birds/b.jpg');
  await close(db);
});

test('photos_recent filters by category when provided', async () => {
  const db = await fresh();
  const base = Date.parse('2026-05-10T12:00:00Z');
  await seedPhoto(db, { path: 'birds/a.jpg', mtimeMs: base, category: 'birds' });
  await seedPhoto(db, { path: 'city/b.jpg', mtimeMs: base + 60_000, category: 'city' });
  const t = createPhotosRecentTool({ db });
  const r = await t.handler({ category: 'birds' });
  assert.equal(r.photos.length, 1);
  assert.equal(r.photos[0].meta.path, 'birds/a.jpg');
  await close(db);
});

test('photos_recent returns empty list when no photos exist', async () => {
  const db = await fresh();
  const t = createPhotosRecentTool({ db });
  const r = await t.handler({});
  assert.deepEqual(r.photos, []);
  await close(db);
});
