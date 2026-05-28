import { HTML_CACHE_MAX_AGE } from './config.ts';
import type { BlobClient, LogRow } from './types.ts';

export interface ManifestEntry {
  slug: string;
  title: string | null;
  url: string;
  published_at: string;
  updated_at: string;
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
    { firstTs: string; lastTs: string; lastAction: string; title: string | null }
  >();
  for (const e of entries) {
    const cur = bySlug.get(e.slug);
    if (!cur) {
      bySlug.set(e.slug, { firstTs: e.ts, lastTs: e.ts, lastAction: e.action, title: e.title });
      continue;
    }
    if (e.ts < cur.firstTs) cur.firstTs = e.ts;
    if (e.ts >= cur.lastTs) {
      cur.lastTs = e.ts;
      cur.lastAction = e.action;
      cur.title = e.title;
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
    });
  }
  out.sort((a, b) => (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0));
  return out;
}

/**
 * Build and PUT the per-user manifest to `users/<userId>/index.json`. Best-effort
 * — the caller wraps this in try/catch so a manifest failure never fails the
 * publish; the next publish's full rebuild repairs it.
 */
export async function writeManifest(
  blob: BlobClient,
  env: { publicUrl: string; userId: string },
  entries: LogRow[],
): Promise<void> {
  const manifest = buildManifest(entries, env);
  await blob.putBlob(`users/${env.userId}/index.json`, JSON.stringify(manifest), {
    contentType: 'application/json; charset=utf-8',
    cacheControlMaxAge: HTML_CACHE_MAX_AGE,
    allowOverwrite: true,
  });
}
