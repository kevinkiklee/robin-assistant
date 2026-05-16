import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import { fileTypeFromBuffer } from 'file-type';
import { visit } from 'unist-util-visit';
import {
  ALLOWED_IMAGE_MIMES,
  ASSET_CACHE_MAX_AGE,
  ASSET_CONCURRENCY,
  ASSET_MAX_BYTES,
  ASSETS_PER_PAGE_MAX,
} from './config.js';

const MIME_TO_EXT = new Map([
  ['image/jpeg', 'jpg'],
  ['image/png', 'png'],
  ['image/gif', 'gif'],
  ['image/webp', 'webp'],
  ['image/avif', 'avif'],
]);

function isLocalImageUrl(url) {
  if (!url) return false;
  if (url.startsWith('data:')) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) {
    return url.toLowerCase().startsWith('file://');
  }
  return true;
}

function resolveLocalPath(url, sourceDir) {
  let p = url;
  if (p.toLowerCase().startsWith('file://')) p = p.replace(/^file:\/\//i, '');
  const abs = resolve(sourceDir, p);
  const rel = relative(sourceDir, abs);
  if (rel.startsWith('..') || rel.includes(`..${sep}`)) {
    throw new Error(`path traversal rejected: ${url}`);
  }
  return abs;
}

async function hashAsset(bytes) {
  return createHash('sha256').update(bytes).digest('hex').slice(0, 16);
}

async function uploadOne({ url, sourceDir, slug, userId, blobClient }) {
  let abs;
  try {
    abs = resolveLocalPath(url, sourceDir);
  } catch (e) {
    return { ok: false, warning: `dropped image (${url}): ${e.message}` };
  }
  let bytes;
  try {
    bytes = await readFile(abs);
  } catch (_e) {
    return { ok: false, warning: `dropped image (${url}): not found or unreadable` };
  }
  if (bytes.length > ASSET_MAX_BYTES) {
    return { ok: false, warning: `dropped image (${url}): exceeds ${ASSET_MAX_BYTES} bytes` };
  }
  const sniff = await fileTypeFromBuffer(bytes);
  if (!sniff) return { ok: false, warning: `dropped image (${url}): could not sniff content-type` };
  if (sniff.mime === 'image/svg+xml')
    return { ok: false, warning: `dropped image (${url}): svg not supported in v1` };
  if (!ALLOWED_IMAGE_MIMES.has(sniff.mime)) {
    return { ok: false, warning: `dropped image (${url}): unsupported mime ${sniff.mime}` };
  }
  const ext = MIME_TO_EXT.get(sniff.mime) || sniff.ext;
  const hash = await hashAsset(bytes);
  const key = `users/${userId}/pages/${slug}/assets/${hash}.${ext}`;
  const exists = (await blobClient.headBlob(key)).exists;
  let blobUrl;
  if (exists) {
    // Use deterministic public URL pattern; same URL for re-upload.
    blobUrl = `RESOLVE_DETERMINISTIC:${key}`;
  } else {
    // Key is content-hash-derived, so same key always means identical bytes —
    // allowOverwrite is safely idempotent and prevents a TOCTOU race when two
    // concurrent workers upload duplicate-content frames (e.g. same photo at
    // two paths) and both see exists=false before either PUT lands.
    const r = await blobClient.putBlob(key, bytes, {
      contentType: sniff.mime,
      cacheControlMaxAge: ASSET_CACHE_MAX_AGE,
      allowOverwrite: true,
    });
    blobUrl = r.url;
  }
  return { ok: true, key, url: blobUrl };
}

async function pMapLimit(items, limit, mapper) {
  const out = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await mapper(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export async function walkLocalImages({
  tree,
  sourceDir,
  slug,
  userId,
  blobClient,
  concurrency = ASSET_CONCURRENCY,
  maxAssets = ASSETS_PER_PAGE_MAX,
}) {
  const targets = [];
  visit(tree, 'image', (node) => {
    if (isLocalImageUrl(node.url)) targets.push(node);
  });

  const warnings = [];
  let workSet = targets;
  if (workSet.length > maxAssets) {
    warnings.push(
      `max-assets (${maxAssets}) exceeded; dropped ${workSet.length - maxAssets} excess image refs`,
    );
    // Drop the excess from the AST and from the work set
    for (const dropped of workSet.slice(maxAssets)) dropped.url = '';
    workSet = workSet.slice(0, maxAssets);
  }

  const results = await pMapLimit(workSet, concurrency, (node) =>
    uploadOne({ url: node.url, sourceDir, slug, userId, blobClient }),
  );

  const assetKeys = [];
  for (let i = 0; i < workSet.length; i++) {
    const r = results[i];
    const node = workSet[i];
    if (!r.ok) {
      warnings.push(r.warning);
      node.url = ''; // keep alt text, drop broken src
      continue;
    }
    node.url = r.url;
    assetKeys.push(r.key);
  }

  return { assetKeys, warnings };
}
