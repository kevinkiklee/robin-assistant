import assert from 'node:assert/strict';
import { mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  buildEventFromPhoto,
  categoryFromPath,
  formatExifSettings,
  walkPhotos,
} from '../../io/integrations/photos/client.js';
import { sync } from '../../io/integrations/photos/sync.js';

function freshDir() {
  const d = join(tmpdir(), `robin-photos-${process.pid}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(d, { recursive: true });
  return d;
}

test('categoryFromPath returns folder relative to collection root', () => {
  assert.equal(categoryFromPath('/Photos/birds/eagle.jpg', '/Photos'), 'birds');
  assert.equal(categoryFromPath('/Photos/cityscape/2026/skyline.jpg', '/Photos'), 'cityscape');
  assert.equal(categoryFromPath('/Photos/loose.jpg', '/Photos'), 'root');
});

test('formatExifSettings concatenates available fields, omits missing', () => {
  const out = formatExifSettings({
    'EXIF:FocalLength': 200,
    'EXIF:FNumber': 2.8,
    'EXIF:ExposureTime': 1 / 500,
    'EXIF:ISO': 400,
  });
  assert.match(out, /200mm/);
  assert.match(out, /f\/2\.8/);
  assert.match(out, /1\/500s/);
  assert.match(out, /ISO 400/);
});

test('formatExifSettings handles long shutters', () => {
  const out = formatExifSettings({ 'EXIF:ExposureTime': 2 });
  assert.match(out, /2s/);
});

test('walkPhotos enumerates jpg/png recursively and skips dotfiles', () => {
  const root = freshDir();
  try {
    mkdirSync(join(root, 'sub'), { recursive: true });
    writeFileSync(join(root, 'a.jpg'), 'x');
    writeFileSync(join(root, 'b.png'), 'x');
    writeFileSync(join(root, 'notes.txt'), 'x');
    writeFileSync(join(root, '.hidden.jpg'), 'x');
    writeFileSync(join(root, 'sub', 'c.jpeg'), 'x');
    const found = [...walkPhotos(root)].map((p) => p.replace(root, '')).sort();
    assert.deepEqual(found, ['/a.jpg', '/b.png', '/sub/c.jpeg']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('walkPhotos skips _review and .DS_Store directories', () => {
  const root = freshDir();
  try {
    mkdirSync(join(root, '_review'), { recursive: true });
    mkdirSync(join(root, 'keep'), { recursive: true });
    writeFileSync(join(root, '_review', 'reject.jpg'), 'x');
    writeFileSync(join(root, 'keep', 'shot.jpg'), 'x');
    const found = [...walkPhotos(root)].map((p) => p.replace(root, '')).sort();
    assert.deepEqual(found, ['/keep/shot.jpg']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('buildEventFromPhoto shapes content, external_id, meta', () => {
  const e = buildEventFromPhoto({
    file: '/Photos/birds/eagle.jpg',
    meta: {
      'EXIF:Model': 'Canon R5',
      'EXIF:LensModel': 'RF 800mm F11',
      'EXIF:FocalLength': 800,
      'EXIF:FNumber': 11,
      'EXIF:ExposureTime': 1 / 1000,
      'EXIF:ISO': 1600,
      'EXIF:DateTimeOriginal': '2026:05:10 07:14:32',
    },
    mtimeMs: 1715324072000,
    collectionDir: '/Photos',
  });
  assert.equal(e.source, 'photos');
  assert.equal(e.external_id, 'photos:birds/eagle.jpg');
  assert.match(e.content, /eagle\.jpg/);
  assert.match(e.content, /Canon R5/);
  assert.match(e.content, /800mm/);
  assert.equal(e.meta.category, 'birds');
  assert.equal(e.meta.camera, 'Canon R5');
  assert.equal(e.meta.lens, 'RF 800mm F11');
  assert.equal(e.meta.iso, 1600);
});

test('buildEventFromPhoto includes GPS when present', () => {
  const e = buildEventFromPhoto({
    file: '/Photos/city/skyline.jpg',
    meta: {
      'EXIF:GPSLatitude': 40.7128,
      'EXIF:GPSLongitude': -74.006,
    },
    mtimeMs: 0,
    collectionDir: '/Photos',
  });
  assert.equal(e.meta.gps_lat, 40.7128);
  assert.equal(e.meta.gps_lon, -74.006);
});

test('sync captures one event per new photo, advances cursor by max mtime', async () => {
  const root = freshDir();
  try {
    writeFileSync(join(root, 'a.jpg'), 'x');
    writeFileSync(join(root, 'b.jpg'), 'x');
    const old = Math.floor(Date.now() / 1000) - 3600;
    utimesSync(join(root, 'a.jpg'), old, old);
    const newer = Math.floor(Date.now() / 1000);
    utimesSync(join(root, 'b.jpg'), newer, newer);
    process.env.PHOTO_COLLECTION_DIR = root;
    const captured = [];
    const r = await sync({
      cursor: { last_mtime_ms: 0 },
      log: () => {},
      capture: async (rows) => {
        captured.push(...rows);
      },
      extractExif: () => ({ 'EXIF:Model': 'Test' }),
    });
    assert.equal(r.count, 2);
    assert.equal(captured.length, 2);
    assert.ok(r.cursor.last_mtime_ms >= newer * 1000);
  } finally {
    delete process.env.PHOTO_COLLECTION_DIR;
    rmSync(root, { recursive: true, force: true });
  }
});

test('sync skips photos with mtime ≤ cursor', async () => {
  const root = freshDir();
  try {
    writeFileSync(join(root, 'old.jpg'), 'x');
    const old = 1715000000;
    utimesSync(join(root, 'old.jpg'), old, old);
    process.env.PHOTO_COLLECTION_DIR = root;
    const captured = [];
    const r = await sync({
      cursor: { last_mtime_ms: old * 1000 + 1 },
      log: () => {},
      capture: async (rows) => {
        captured.push(...rows);
      },
      extractExif: () => ({}),
    });
    assert.equal(r.count, 0);
    assert.equal(captured.length, 0);
  } finally {
    delete process.env.PHOTO_COLLECTION_DIR;
    rmSync(root, { recursive: true, force: true });
  }
});

test('sync handles exif extractor errors gracefully', async () => {
  const root = freshDir();
  try {
    writeFileSync(join(root, 'a.jpg'), 'x');
    process.env.PHOTO_COLLECTION_DIR = root;
    const captured = [];
    const r = await sync({
      cursor: null,
      log: () => {},
      capture: async (rows) => {
        captured.push(...rows);
      },
      extractExif: () => {
        throw new Error('boom');
      },
    });
    // Photo still recorded, just without EXIF metadata.
    assert.equal(r.count, 1);
    assert.equal(captured.length, 1);
    assert.equal(captured[0].meta.camera, null);
  } finally {
    delete process.env.PHOTO_COLLECTION_DIR;
    rmSync(root, { recursive: true, force: true });
  }
});
