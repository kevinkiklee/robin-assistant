import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { buildEventFromPhoto, extractExifWithExiftool, walkPhotos } from './client.js';

const SCAN_LIMIT = 500;

export function photoCollectionDir() {
  return process.env.PHOTO_COLLECTION_DIR ?? join(homedir(), 'Photography', 'Collection');
}

export async function sync(ctx) {
  const collectionDir = photoCollectionDir();
  const sinceMtimeMs = ctx.cursor?.last_mtime_ms ?? 0;
  const extractExif = ctx.extractExif ?? extractExifWithExiftool;
  const events = [];
  let maxMtimeMs = sinceMtimeMs;
  let scanned = 0;

  for (const file of walkPhotos(collectionDir)) {
    if (scanned >= SCAN_LIMIT) break;
    let mtimeMs;
    try {
      mtimeMs = statSync(file).mtimeMs;
    } catch {
      continue;
    }
    if (mtimeMs <= sinceMtimeMs) continue;
    scanned += 1;
    let exif = {};
    try {
      exif = extractExif(file) ?? {};
    } catch (e) {
      ctx.log?.(`photos: exif failed for ${file}: ${e.message}`);
    }
    events.push(buildEventFromPhoto({ file, meta: exif, mtimeMs, collectionDir }));
    if (mtimeMs > maxMtimeMs) maxMtimeMs = mtimeMs;
  }

  if (events.length > 0) await ctx.capture(events);
  return {
    count: events.length,
    cursor: { last_mtime_ms: maxMtimeMs, last_run_at: new Date().toISOString() },
  };
}
