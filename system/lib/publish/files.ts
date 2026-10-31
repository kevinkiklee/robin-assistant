import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import type { Root as MdastRoot } from 'mdast';
import { visit } from 'unist-util-visit';
import { ASSET_CACHE_MAX_AGE, ASSET_MAX_BYTES, ASSETS_PER_PAGE_MAX } from './config.ts';
import { hashAsset, resolveLocalPath } from './images.ts';
import type { BlobClient } from './types.ts';

/**
 * Downloadable attachments: a link (markdown `[x](preset.xmp)` or HTML
 * `<a href="preset.xmp">`) to a local file of an allowed type is uploaded next
 * to the page and the href rewritten — preset pages link their .xmp files this
 * way. Served as application/octet-stream (except PDF) so the
 * browser downloads instead of rendering. HTML/SVG/JS are never allowed: the
 * blob origin has no CSP, so a served document there would be live.
 *
 * Key: users/<u>/pages/<slug>/files/<content-hash>/<filename> — the hash keeps
 * re-uploads idempotent, the filename survives so a downloaded preset keeps
 * its name.
 */
export const ATTACHMENT_TYPES: ReadonlyMap<string, string> = new Map([
  ['xmp', 'application/octet-stream'],
  ['cube', 'application/octet-stream'],
  ['dcp', 'application/octet-stream'],
  ['lrtemplate', 'application/octet-stream'],
  ['gpx', 'application/octet-stream'],
  ['csv', 'application/octet-stream'],
  ['zip', 'application/zip'],
  ['pdf', 'application/pdf'],
]);

function extOf(path: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(path);
  return m ? m[1].toLowerCase() : '';
}

/** A relative (or file://) link to an attachment type; anchors and site paths are not. */
export function isLocalAttachmentUrl(url: string | undefined): boolean {
  if (!url || url.startsWith('#') || url.startsWith('/') || url.startsWith('?')) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(url) && !/^file:\/\//i.test(url)) return false;
  return ATTACHMENT_TYPES.has(extOf(stripQuery(url)));
}

function stripQuery(url: string): string {
  return url.replace(/[?#].*$/, '');
}

export function attachmentFilename(path: string): string {
  return basename(path).replace(/[^A-Za-z0-9._-]+/g, '-') || 'file';
}

export interface LinkRef {
  url: string;
}

export interface UploadAttachmentsInput {
  refs: LinkRef[];
  sourceDir: string;
  slug: string;
  userId: string;
  blobClient: BlobClient;
  maxFiles?: number;
}

export interface UploadAttachmentsResult {
  assetKeys: string[];
  warnings: string[];
}

/**
 * Upload each ref's file and rewrite `ref.url` in place. A failed ref keeps
 * its original href (a broken link beats a silently-vanished one) and is
 * reported. The same file linked twice uploads once.
 */
export async function uploadAttachments(
  input: UploadAttachmentsInput,
): Promise<UploadAttachmentsResult> {
  const warnings: string[] = [];
  const assetKeys: string[] = [];
  const done = new Map<string, string>();
  const max = input.maxFiles ?? ASSETS_PER_PAGE_MAX;
  for (const ref of input.refs) {
    const target = stripQuery(ref.url);
    const prior = done.get(target);
    if (prior) {
      ref.url = prior;
      continue;
    }
    if (done.size >= max) {
      warnings.push(`max-attachments (${max}) exceeded; left ${ref.url} unlinked`);
      continue;
    }
    let abs: string;
    try {
      abs = resolveLocalPath(decodeURIComponent(target), input.sourceDir);
    } catch (err) {
      warnings.push(`attachment not uploaded (${ref.url}): ${(err as Error).message}`);
      continue;
    }
    let bytes: Buffer;
    try {
      bytes = await readFile(abs);
    } catch {
      warnings.push(`attachment not uploaded (${ref.url}): not found or unreadable`);
      continue;
    }
    if (bytes.length > ASSET_MAX_BYTES) {
      warnings.push(`attachment not uploaded (${ref.url}): exceeds ${ASSET_MAX_BYTES} bytes`);
      continue;
    }
    const key = `users/${input.userId}/pages/${input.slug}/files/${hashAsset(bytes)}/${attachmentFilename(abs)}`;
    const head = await input.blobClient.headBlob(key);
    let url: string;
    if (head.exists) {
      url = `RESOLVE_DETERMINISTIC:${key}`;
    } else {
      const r = await input.blobClient.putBlob(key, bytes, {
        contentType: ATTACHMENT_TYPES.get(extOf(abs)) ?? 'application/octet-stream',
        cacheControlMaxAge: ASSET_CACHE_MAX_AGE,
        allowOverwrite: true,
      });
      url = r.url;
    }
    done.set(target, url);
    ref.url = url;
    assetKeys.push(key);
  }
  return { assetKeys, warnings };
}

/** Markdown: collect local attachment links (and definitions) from the tree. */
export function collectMarkdownAttachmentRefs(tree: MdastRoot): LinkRef[] {
  const refs: LinkRef[] = [];
  visit(tree, (node) => {
    const n = node as { type: string; url?: string };
    if ((n.type === 'link' || n.type === 'definition') && isLocalAttachmentUrl(n.url)) {
      refs.push(n as LinkRef);
    }
  });
  return refs;
}
