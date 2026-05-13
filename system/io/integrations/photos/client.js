import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { basename, extname, join, relative } from 'node:path';

const PHOTO_EXTS = new Set(['.jpg', '.jpeg', '.png', '.tiff', '.tif']);
const SKIP_NAMES = new Set(['_review', 'node_modules', '.DS_Store']);

export function* walkPhotos(dir, skip = SKIP_NAMES) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') || skip.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkPhotos(path, skip);
    } else if (entry.isFile() && PHOTO_EXTS.has(extname(entry.name).toLowerCase())) {
      yield path;
    }
  }
}

export function categoryFromPath(file, collectionDir) {
  const rel = relative(collectionDir, file);
  const parts = rel.split('/');
  return parts.length > 1 ? parts[0] : 'root';
}

export function extractExifWithExiftool(file) {
  const out = execFileSync('exiftool', ['-j', '-G', '-n', '-fast2', file], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    maxBuffer: 4 * 1024 * 1024,
  });
  const parsed = JSON.parse(out);
  return parsed[0] ?? {};
}

function fmtShutter(t) {
  if (t === undefined || t === null) return '';
  const v = Number(t);
  if (!Number.isFinite(v) || v <= 0) return String(t);
  if (v >= 1) return `${v}s`;
  return `1/${Math.round(1 / v)}s`;
}

export function formatExifSettings(meta) {
  const fl = meta['EXIF:FocalLength'] ? `${meta['EXIF:FocalLength']}mm` : '';
  const aperture = meta['EXIF:FNumber'] ? `f/${meta['EXIF:FNumber']}` : '';
  const shutter = fmtShutter(meta['EXIF:ExposureTime']);
  const iso = meta['EXIF:ISO'] ? `ISO ${meta['EXIF:ISO']}` : '';
  return [fl, aperture, shutter, iso].filter(Boolean).join(' · ');
}

function num(x) {
  return typeof x === 'number' && Number.isFinite(x) ? x : null;
}

export function buildEventFromPhoto({ file, meta, mtimeMs, collectionDir }) {
  const rel = relative(collectionDir, file);
  const category = categoryFromPath(file, collectionDir);
  const camera = meta['EXIF:Model'] ?? meta['IFD0:Model'] ?? null;
  const lens =
    meta['EXIF:LensModel'] ?? meta['Composite:LensID'] ?? meta['MakerNotes:LensType'] ?? null;
  const focalLength = num(meta['EXIF:FocalLength']);
  const aperture = num(meta['EXIF:FNumber']);
  const exposure = num(meta['EXIF:ExposureTime']);
  const iso = num(meta['EXIF:ISO']);
  const width = num(meta['EXIF:ExifImageWidth']) ?? num(meta['File:ImageWidth']);
  const height = num(meta['EXIF:ExifImageHeight']) ?? num(meta['File:ImageHeight']);
  const gpsLat = num(meta['EXIF:GPSLatitude']);
  const gpsLon = num(meta['EXIF:GPSLongitude']);
  const captured = meta['EXIF:DateTimeOriginal'] ?? meta['File:FileModifyDate'] ?? null;
  const settings = formatExifSettings(meta);
  const contentParts = [
    basename(file),
    category !== 'root' ? `[${category}]` : null,
    camera,
    settings,
  ].filter(Boolean);
  return {
    source: 'photos',
    content: contentParts.join(' · '),
    ts: new Date(mtimeMs),
    external_id: `photos:${rel}`,
    meta: {
      path: rel,
      category,
      camera,
      lens,
      focal_length_mm: focalLength,
      aperture,
      exposure_seconds: exposure,
      iso,
      width,
      height,
      gps_lat: gpsLat,
      gps_lon: gpsLon,
      captured_at: captured,
      mtime_ms: mtimeMs,
    },
  };
}
