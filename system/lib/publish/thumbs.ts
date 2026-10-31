// Page-screenshot thumbnails for the askrobin.io index.
//
// The index shows a page's first photo as its preview. A third of the pages
// (lens tables, gear notes, setup guides) have no photo, so they showed a text
// block instead. For those pages this captures a screenshot of the published
// page itself — its title area, in its own design — and stores it beside the
// page blobs:
//
//   users/<user>/thumbs/<public-slug>.jpg     the screenshot (800px JPEG)
//   users/<user>/thumbs/index.json            { slug: { url, updated_at } }
//
// askrobin.io reads the index and uses a screenshot wherever a page has no
// photo of its own. A thumbnail is retaken only when the page's manifest
// `updated_at` changes. Capture uses the system Chrome (headless) and macOS
// `sips` for the resize — no new dependency; on other platforms it no-ops.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { BlobClient, PublishEnv } from './types.ts';

const run = promisify(execFile);

export const CHROME_PATH =
  process.env.ROBIN_CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SIPS = '/usr/bin/sips';
const SHOT_W = 1200;
const SHOT_H = 750;
const OUT_W = 800;
const CONCURRENCY = 3;

/** Screenshot a URL; null when capture fails. Injectable for tests. */
export type Capture = (url: string) => Promise<Buffer | null>;

export interface ThumbEntry {
  /** Screenshot URL; '' when the page has a photo and needs none. */
  url: string;
  updated_at: string;
  /** The page has its own photo (recorded so later runs skip it). */
  photo?: true;
}
export type ThumbIndex = Record<string, ThumbEntry>;

export function canCapture(): boolean {
  return process.platform === 'darwin' && existsSync(CHROME_PATH) && existsSync(SIPS);
}

export const captureWithChrome: Capture = async (url) => {
  const dir = await mkdtemp(join(tmpdir(), 'robin-thumb-'));
  try {
    const png = join(dir, 'shot.png');
    const jpg = join(dir, 'shot.jpg');
    await run(
      CHROME_PATH,
      [
        '--headless=new',
        '--disable-gpu',
        '--hide-scrollbars',
        '--force-color-profile=srgb',
        '--force-prefers-reduced-motion',
        // Deterministic look regardless of the Mac's appearance at capture time;
        // dark matches how the index is used.
        '--force-dark-mode',
        `--user-data-dir=${join(dir, 'profile')}`,
        `--window-size=${SHOT_W},${SHOT_H}`,
        '--virtual-time-budget=8000', // let fonts, images and page scripts settle
        `--screenshot=${png}`,
        url,
      ],
      { timeout: 60_000 },
    );
    await run(
      SIPS,
      [
        '--resampleWidth',
        String(OUT_W),
        '-s',
        'format',
        'jpeg',
        '-s',
        'formatOptions',
        '72',
        png,
        '--out',
        jpg,
      ],
      { timeout: 30_000 },
    );
    return await readFile(jpg);
  } catch {
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
};

/**
 * Whether the page already has a photo the index uses as its cover — the
 * same rule as askrobin.io's extractCover: an <img> from a blob store under
 * /users/, not declared smaller than 160px.
 */
export function hasPhoto(html: string): boolean {
  const body = html.replace(/<head\b[\s\S]*?<\/head>/gi, ' ');
  const re = /<img\b([^>]*)>/gi;
  for (let m = re.exec(body); m; m = re.exec(body)) {
    const attrs = m[1] ?? '';
    const src = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1] ?? '';
    if (!/^https:\/\/[a-z0-9]+\.public\.blob\.vercel-storage\.com\/users\//i.test(src)) continue;
    if (!/\.(?:jpe?g|png|webp|avif)$/i.test(src)) continue;
    const w = Number(/\bwidth\s*=\s*["']?(\d+)/i.exec(attrs)?.[1] ?? 0);
    const h = Number(/\bheight\s*=\s*["']?(\d+)/i.exec(attrs)?.[1] ?? 0);
    if ((w && w < 160) || (h && h < 160)) continue;
    return true;
  }
  return false;
}

export const thumbsIndexKey = (userId: string) => `users/${userId}/thumbs/index.json`;
export const thumbKey = (userId: string, publicSlug: string) =>
  `users/${userId}/thumbs/${publicSlug}.jpg`;

interface ManifestRow {
  slug: string;
  url: string;
  updated_at: string;
}

async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url);
    return res.ok ? ((await res.json()) as T) : null;
  } catch {
    return null;
  }
}

export interface UpdateThumbsOptions {
  env: PublishEnv;
  blobClient: BlobClient;
  capture: Capture;
  /** Limit to these base slugs (a publish passes just its own). */
  slugs?: string[];
  /** Retake even when the page hasn't changed. */
  force?: boolean;
  /** Progress lines (CLI backfill). */
  log?: (line: string) => void;
}

export interface UpdateThumbsResult {
  captured: string[];
  /** Pages that have a photo, so need no screenshot. */
  withPhoto: number;
  unchanged: number;
  failed: string[];
  removed: string[];
}

/**
 * Bring screenshot thumbnails up to date with the live manifest. Never
 * throws for a single page; the index is written once at the end.
 */
export async function updateThumbs(opts: UpdateThumbsOptions): Promise<UpdateThumbsResult> {
  const { env, blobClient } = opts;
  const base = env.blobPublicBaseUrl;
  const bust = `v=${Date.now()}`; // blob reads are CDN-cached; read our own writes
  const manifest =
    (await fetchJson<ManifestRow[]>(`${base}/users/${env.userId}/index.json?${bust}`)) ?? [];
  const index: ThumbIndex =
    (await fetchJson<ThumbIndex>(`${base}/${thumbsIndexKey(env.userId)}?${bust}`)) ?? {};
  const result: UpdateThumbsResult = {
    captured: [],
    withPhoto: 0,
    unchanged: 0,
    failed: [],
    removed: [],
  };
  let changed = false;
  // Changes made by this run, re-applied onto a fresh read before writing.
  const updates: Record<string, ThumbEntry | null> = {};

  const live = new Set(manifest.map((e) => e.slug));
  if (!opts.slugs) {
    for (const slug of Object.keys(index)) {
      if (live.has(slug)) continue;
      const pub = index[slug]?.url
        .split('/')
        .pop()
        ?.replace(/\.jpg$/, '');
      if (pub) await blobClient.delBlob(thumbKey(env.userId, pub)).catch(() => undefined);
      delete index[slug];
      updates[slug] = null;
      result.removed.push(slug);
      changed = true;
    }
  }

  const todo = manifest.filter((e) => !opts.slugs || opts.slugs.includes(e.slug));
  let cursor = 0;
  const worker = async () => {
    while (cursor < todo.length) {
      const e = todo[cursor++];
      if (!e) break;
      const pub = e.url.split('/').pop() ?? '';
      if (!opts.force && index[e.slug]?.updated_at === e.updated_at) {
        result.unchanged++;
        continue;
      }
      const html = await fetch(`${base}/users/${env.userId}/pages/${pub}/index.html?${bust}`)
        .then((r) => (r.ok ? r.text() : null))
        .catch(() => null);
      if (html == null) {
        result.failed.push(e.slug);
        continue;
      }
      if (hasPhoto(html)) {
        result.withPhoto++;
        if (index[e.slug]?.url) {
          await blobClient.delBlob(thumbKey(env.userId, pub)).catch(() => undefined);
        }
        index[e.slug] = { url: '', updated_at: e.updated_at, photo: true };
        updates[e.slug] = index[e.slug] ?? null;
        changed = true;
        continue;
      }
      const shot = await opts.capture(e.url);
      if (!shot) {
        result.failed.push(e.slug);
        opts.log?.(`  ✗ ${e.slug}`);
        continue;
      }
      const key = thumbKey(env.userId, pub);
      await blobClient.putBlob(key, shot, {
        access: 'public',
        contentType: 'image/jpeg',
        allowOverwrite: true,
        cacheControlMaxAge: 60,
      });
      index[e.slug] = { url: `${base}/${key}`, updated_at: e.updated_at };
      updates[e.slug] = index[e.slug] ?? null;
      result.captured.push(e.slug);
      changed = true;
      opts.log?.(`  ✓ ${e.slug} (${Math.round(shot.length / 1024)} KB)`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, todo.length) }, worker));

  if (changed) {
    // Concurrent publishes each read-modify-write this file. Re-read it now and
    // apply only this run's changes, so the race window is the write itself
    // rather than the whole capture.
    const fresh =
      (await fetchJson<ThumbIndex>(`${base}/${thumbsIndexKey(env.userId)}?v=${Date.now()}`)) ??
      index;
    for (const [slug, entry] of Object.entries(updates)) {
      if (entry) fresh[slug] = entry;
      else delete fresh[slug];
    }
    await blobClient.putBlob(thumbsIndexKey(env.userId), JSON.stringify(fresh), {
      access: 'public',
      contentType: 'application/json; charset=utf-8',
      allowOverwrite: true,
      cacheControlMaxAge: 60,
    });
  }
  return result;
}

/** Drop a deleted page's thumbnail (best effort; no capture needed). */
export async function dropThumb(
  env: PublishEnv,
  blobClient: BlobClient,
  slug: string,
): Promise<void> {
  const key = thumbsIndexKey(env.userId);
  const index = await fetchJson<ThumbIndex>(`${env.blobPublicBaseUrl}/${key}?v=${Date.now()}`);
  const entry = index?.[slug];
  if (!index || !entry) return;
  const pub = entry.url
    .split('/')
    .pop()
    ?.replace(/\.jpg$/, '');
  if (pub) await blobClient.delBlob(thumbKey(env.userId, pub)).catch(() => undefined);
  delete index[slug];
  await blobClient.putBlob(key, JSON.stringify(index), {
    access: 'public',
    contentType: 'application/json; charset=utf-8',
    allowOverwrite: true,
    cacheControlMaxAge: 60,
  });
}
