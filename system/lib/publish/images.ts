import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import { fileTypeFromBuffer } from 'file-type';
import type { Root as MdastRoot } from 'mdast';
import { visit } from 'unist-util-visit';
import {
  ALLOWED_IMAGE_MIMES,
  ASSET_CACHE_MAX_AGE,
  ASSET_CONCURRENCY,
  ASSET_MAX_BYTES,
  ASSETS_PER_PAGE_MAX,
} from './config.ts';
import type { BlobClient } from './types.ts';

const MIME_TO_EXT = new Map([
  ['image/jpeg', 'jpg'],
  ['image/png', 'png'],
  ['image/gif', 'gif'],
  ['image/webp', 'webp'],
  ['image/avif', 'avif'],
]);

function isLocalImageUrl(url: string | undefined): boolean {
  if (!url) return false;
  if (url.startsWith('data:')) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return url.toLowerCase().startsWith('file://');
  return true;
}

function resolveLocalPath(url: string, sourceDir: string): string {
  let p = url;
  if (p.toLowerCase().startsWith('file://')) p = p.replace(/^file:\/\//i, '');
  const abs = resolve(sourceDir, p);
  const rel = relative(sourceDir, abs);
  if (rel.startsWith('..') || rel.includes(`..${sep}`)) {
    throw new Error(`path traversal rejected: ${url}`);
  }
  return abs;
}

function hashAsset(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex').slice(0, 16);
}

interface UploadOneInput {
  url: string;
  sourceDir: string;
  slug: string;
  userId: string;
  blobClient: BlobClient;
}

type UploadOneResult = { ok: true; key: string; url: string } | { ok: false; warning: string };

async function uploadOne(input: UploadOneInput): Promise<UploadOneResult> {
  let abs: string;
  try {
    abs = resolveLocalPath(input.url, input.sourceDir);
  } catch (e) {
    return { ok: false, warning: `dropped image (${input.url}): ${(e as Error).message}` };
  }
  let bytes: Buffer;
  try {
    bytes = await readFile(abs);
  } catch {
    return { ok: false, warning: `dropped image (${input.url}): not found or unreadable` };
  }
  if (bytes.length > ASSET_MAX_BYTES) {
    return { ok: false, warning: `dropped image (${input.url}): exceeds ${ASSET_MAX_BYTES} bytes` };
  }
  const sniff = await fileTypeFromBuffer(bytes);
  if (!sniff) {
    return { ok: false, warning: `dropped image (${input.url}): could not sniff content-type` };
  }
  // file-type's MimeType union doesn't include SVG; check defensively via string.
  if ((sniff.mime as string) === 'image/svg+xml') {
    return { ok: false, warning: `dropped image (${input.url}): svg not supported` };
  }
  if (!ALLOWED_IMAGE_MIMES.has(sniff.mime)) {
    return { ok: false, warning: `dropped image (${input.url}): unsupported mime ${sniff.mime}` };
  }
  const ext = MIME_TO_EXT.get(sniff.mime) ?? sniff.ext;
  const hash = hashAsset(bytes);
  const key = `users/${input.userId}/pages/${input.slug}/assets/${hash}.${ext}`;
  const head = await input.blobClient.headBlob(key);
  let blobUrl: string;
  if (head.exists) {
    // Content-hash-derived key — same key always means identical bytes.
    blobUrl = `RESOLVE_DETERMINISTIC:${key}`;
  } else {
    const r = await input.blobClient.putBlob(key, bytes, {
      contentType: sniff.mime,
      cacheControlMaxAge: ASSET_CACHE_MAX_AGE,
      allowOverwrite: true,
    });
    blobUrl = r.url;
  }
  return { ok: true, key, url: blobUrl };
}

async function pMapLimit<T, U>(
  items: T[],
  limit: number,
  mapper: (item: T, idx: number) => Promise<U>,
): Promise<U[]> {
  const out = new Array<U>(items.length);
  let i = 0;
  async function worker(): Promise<void> {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await mapper(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export interface WalkLocalImagesInput {
  tree: MdastRoot;
  sourceDir: string;
  slug: string;
  userId: string;
  blobClient: BlobClient;
  concurrency?: number;
  maxAssets?: number;
}

export interface WalkLocalImagesResult {
  assetKeys: string[];
  warnings: string[];
}

export async function walkLocalImages(input: WalkLocalImagesInput): Promise<WalkLocalImagesResult> {
  const concurrency = input.concurrency ?? ASSET_CONCURRENCY;
  const maxAssets = input.maxAssets ?? ASSETS_PER_PAGE_MAX;
  const targets: Array<{ url: string }> = [];
  visit(input.tree, 'image', (node: { url?: string }) => {
    if (isLocalImageUrl(node.url)) targets.push(node as { url: string });
  });

  const warnings: string[] = [];
  let workSet = targets;
  if (workSet.length > maxAssets) {
    warnings.push(
      `max-assets (${maxAssets}) exceeded; dropped ${workSet.length - maxAssets} excess image refs`,
    );
    for (const dropped of workSet.slice(maxAssets)) dropped.url = '';
    workSet = workSet.slice(0, maxAssets);
  }

  const results = await pMapLimit(workSet, concurrency, (node) =>
    uploadOne({
      url: node.url,
      sourceDir: input.sourceDir,
      slug: input.slug,
      userId: input.userId,
      blobClient: input.blobClient,
    }),
  );

  const assetKeys: string[] = [];
  for (let i = 0; i < workSet.length; i++) {
    const r = results[i];
    const node = workSet[i];
    if (!r.ok) {
      warnings.push(r.warning);
      node.url = '';
      continue;
    }
    node.url = r.url;
    assetKeys.push(r.key);
  }
  return { assetKeys, warnings };
}
