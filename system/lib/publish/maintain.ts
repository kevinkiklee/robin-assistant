// Maintenance operations on the published-pages set that don't publish
// content: recategorize (fix a live page's category without republishing)
// and sync (fold web-side pending ops into the local log).
import { dirname, join } from 'node:path';
import { CATEGORIES, EXIT_INPUT, EXIT_POLICY, UNCATEGORIZED } from './config.ts';
import { appendLogEntry, readLog } from './log.ts';
import { buildManifest, writeManifest } from './manifest.ts';
import { PublishError, publish } from './orchestrate.ts';
import { reconcilePending } from './pending.ts';
import { sanitizeSlug, toPublicSlug } from './slug.ts';
import { dropThumb } from './thumbs.ts';
import type { BlobClient, LogRow, PublishEnv, PublishResult } from './types.ts';

export interface MaintainOptions {
  env: PublishEnv;
  blobClient: BlobClient;
  logPath: string;
}

export interface RecategorizeResult {
  slug: string;
  category: string;
  url: string;
  warnings: string[];
}

/**
 * Change a live page's category by appending a metadata-only `recategorize`
 * log row (a clone of the latest row so blob_key/assets stay findable), then
 * rebuilding the manifest. The page blob is untouched and `updated_at` does
 * not bump (buildManifest folds recategorize rows as category-only).
 *
 * Note: source frontmatter still wins on republish — a page whose source .md
 * lacks `category:` reverts to Uncategorized the next time it's published.
 */
export async function recategorize(
  opts: MaintainOptions & { slug: string; category: string },
): Promise<RecategorizeResult> {
  const slug = sanitizeSlug(opts.slug);
  if (!slug) throw new PublishError(EXIT_INPUT, `invalid slug: ${opts.slug}`);
  const category = opts.category;
  if (!(CATEGORIES as readonly string[]).includes(category) && category !== UNCATEGORIZED) {
    throw new PublishError(
      EXIT_POLICY,
      `unknown category "${category}" — valid: ${CATEGORIES.join(', ')}, ${UNCATEGORIZED}`,
    );
  }

  const { entries } = await readLog(opts.logPath);
  const latest = [...entries].reverse().find((e) => e.slug === slug);
  if (!latest) throw new PublishError(EXIT_INPUT, `unknown slug: ${slug} (never published)`);
  if (latest.action === 'delete') {
    throw new PublishError(EXIT_INPUT, `slug ${slug} is deleted — republish it instead`);
  }
  if ((latest.category ?? UNCATEGORIZED) === category) {
    return { slug, category, url: latest.url, warnings: [`already in "${category}" — no-op`] };
  }

  const row: LogRow = { ...latest, ts: new Date().toISOString(), action: 'recategorize', category };
  await appendLogEntry(opts.logPath, row);

  const warnings: string[] = [];
  try {
    const { entries: updated } = await readLog(opts.logPath);
    await writeManifest(opts.blobClient, opts.env, updated);
  } catch (err) {
    warnings.push(`manifest write failed: ${(err as Error).message}`);
  }
  return { slug, category, url: latest.url, warnings };
}

export interface SyncResult {
  applied: string[];
  stale: string[];
  manifest_entries: number;
  warnings: string[];
}

/**
 * Reconcile pending web-side ops and rebuild the manifest. Run it after
 * editing pages from the askrobin.io index so `robin published` and the
 * local log reflect them without waiting for the next publish.
 */
export async function syncDeletes(opts: MaintainOptions): Promise<SyncResult> {
  const rec = await reconcilePending({
    env: opts.env,
    blobClient: opts.blobClient,
    logPath: opts.logPath,
  });
  const warnings = [...rec.warnings];
  const { entries } = await readLog(opts.logPath);
  let manifestEntries = 0;
  try {
    await writeManifest(opts.blobClient, opts.env, entries);
    manifestEntries = buildManifest(entries, opts.env).length;
  } catch (err) {
    warnings.push(`manifest write failed: ${(err as Error).message}`);
  }
  return { applied: rec.applied, stale: rec.stale, manifest_entries: manifestEntries, warnings };
}

/** Re-derive a page's public (hashed) URL — convenience for maintenance CLIs. */
export function pageUrlFor(env: PublishEnv, slug: string): string {
  return `${env.publicUrl}/@${env.userId}/${toPublicSlug(env.userId, slug, env.urlSecret)}`;
}

/**
 * Library-level page delete: `publish({ mode: 'delete' })` (page + assets,
 * log row, manifest) then the page's index thumbnail. A thumbnail failure is a
 * warning on the result, never a throw — the page is already gone by then.
 * `telemetryPath` defaults to the sibling `logs/publish.log` of the publish log.
 */
export async function deletePage(
  opts: MaintainOptions & { slug: string; telemetryPath?: string; dryRun?: boolean },
): Promise<PublishResult> {
  const result = await publish({
    source: null,
    slug: opts.slug,
    mode: 'delete',
    forceUntrusted: false,
    allowSensitive: false,
    dryRun: opts.dryRun ?? false,
    env: opts.env,
    blobClient: opts.blobClient,
    logPath: opts.logPath,
    telemetryPath: opts.telemetryPath ?? join(dirname(opts.logPath), '..', 'logs', 'publish.log'),
  });
  if (!opts.dryRun) {
    try {
      await dropThumb(opts.env, opts.blobClient, result.slug);
    } catch (err) {
      result.warnings.push(`thumbnail cleanup failed: ${(err as Error).message}`);
    }
  }
  return result;
}
