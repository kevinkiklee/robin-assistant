import { HTML_CACHE_MAX_AGE, UNCATEGORIZED } from './config.ts';
import type { BlobClient, LogRow } from './types.ts';

export interface ManifestEntry {
  slug: string;
  title: string | null;
  url: string;
  published_at: string;
  updated_at: string;
  category: string;
  visibility: 'public' | 'private';
  description: string | null;
}

/**
 * Fold the LogRow log into one entry per live slug. Treats all rows as the
 * current publisher's (single-publisher assumption — Robin is the sole
 * publisher). `url` is recomputed from `env` so historical `/p/` URLs in the
 * log never leak into the manifest. Slugs whose latest action is `delete` are
 * dropped. Result is sorted newest-first by `updated_at`.
 */
export function buildManifest(
  entries: LogRow[],
  env: { publicUrl: string; userId: string },
): ManifestEntry[] {
  const bySlug = new Map<
    string,
    {
      firstTs: string; lastTs: string; lastAction: string;
      title: string | null; category: string; visibility: 'public' | 'private'; description: string | null;
    }
  >();
  for (const e of entries) {
    const cat = e.category ?? UNCATEGORIZED;
    const vis = e.visibility ?? 'public';
    const desc = e.description ?? null;
    const cur = bySlug.get(e.slug);
    if (!cur) {
      bySlug.set(e.slug, {
        firstTs: e.ts, lastTs: e.ts, lastAction: e.action,
        title: e.title, category: cat, visibility: vis, description: desc,
      });
      continue;
    }
    if (e.ts < cur.firstTs) cur.firstTs = e.ts;
    if (e.ts >= cur.lastTs) {
      cur.lastTs = e.ts; cur.lastAction = e.action;
      cur.title = e.title; cur.category = cat; cur.visibility = vis; cur.description = desc;
    }
  }
  const out: ManifestEntry[] = [];
  for (const [slug, v] of bySlug) {
    if (v.lastAction === 'delete') continue;
    out.push({
      slug,
      title: v.title,
      url: `${env.publicUrl}/@${env.userId}/${slug}`,
      published_at: v.firstTs,
      updated_at: v.lastTs,
      category: v.category,
      visibility: v.visibility,
      description: v.description,
    });
  }
  out.sort((a, b) => (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0));
  return out;
}

/**
 * Build and PUT the per-user manifests. Public entries go to
 * `users/<userId>/index.json` (access:'public') on the PUBLIC client; private
 * entries go to `users/<userId>/index.private.json` (access:'private') on the
 * PRIVATE client. The private manifest is skipped entirely when no private
 * client is provided — writing a private-access blob to a public store throws
 * "Cannot use private access on a public store", so the guard is here.
 * Best-effort — the caller wraps this in try/catch so a manifest failure never
 * fails the publish; the next publish's full rebuild repairs it.
 */
export async function writeManifest(
  blob: BlobClient,                // PUBLIC client
  env: { publicUrl: string; userId: string },
  entries: LogRow[],
  privateBlob?: BlobClient | null, // PRIVATE client; omit/null → skip private manifest
): Promise<void> {
  const all = buildManifest(entries, env);
  const publicEntries = all.filter((e) => e.visibility !== 'private');
  const privateEntries = all.filter((e) => e.visibility === 'private');
  await blob.putBlob(`users/${env.userId}/index.json`, JSON.stringify(publicEntries), {
    contentType: 'application/json; charset=utf-8',
    cacheControlMaxAge: HTML_CACHE_MAX_AGE,
    allowOverwrite: true,
    access: 'public',
  });
  if (privateBlob) {
    await privateBlob.putBlob(`users/${env.userId}/index.private.json`, JSON.stringify(privateEntries), {
      contentType: 'application/json; charset=utf-8',
      cacheControlMaxAge: HTML_CACHE_MAX_AGE,
      allowOverwrite: true,
      access: 'private',
    });
  }
}
