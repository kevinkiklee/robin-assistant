// Maintenance operations on the published-pages set that don't publish
// content: recategorize (fix a live page's category without republishing)
// and deletePage (library-level delete, used by the CLI and life_sync).
import { dirname, join } from 'node:path';
import { CATEGORIES, EXIT_INPUT, EXIT_POLICY, UNCATEGORIZED } from './config.ts';
import { appendLogEntry, readLog } from './log.ts';
import { PublishError, publish } from './orchestrate.ts';
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
 * log row (a clone of the latest row so blob_key/assets stay findable). The
 * page blob is untouched and `updated_at` does not bump (buildManifest folds
 * recategorize rows as category-only).
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
  return { slug, category, url: latest.url, warnings: [] };
}

/** Re-derive a page's public (hashed) URL — convenience for maintenance CLIs. */
export function pageUrlFor(env: PublishEnv, slug: string): string {
  return `${env.publicUrl}/@${env.userId}/${toPublicSlug(env.userId, slug, env.urlSecret)}`;
}

/**
 * Library-level page delete: `publish({ mode: 'delete' })` (page + assets,
 * log row) then the page's thumbnail. A thumbnail failure is a
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
