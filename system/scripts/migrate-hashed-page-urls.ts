// One-shot migration (2026-08-19): move every live published page from its
// guessable blob key (users/<u>/pages/<slug>/index.html) to the hashed key
// (users/<u>/pages/<slug>-<hash10>/index.html), rewriting internal /@<u>/<slug>
// links inside the stored HTML, appending a log row per move so future
// deletes/republishes resolve the right key, and finally rebuilding the
// index.json manifest. Idempotent: pages whose latest log row already points
// at the hashed key are skipped, as are already-hashed link targets.
//
//   pnpm exec tsx system/scripts/migrate-hashed-page-urls.ts --dry-run
//   pnpm exec tsx system/scripts/migrate-hashed-page-urls.ts
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { resolveUserDataDir } from '../lib/paths.ts';
import { createBlobClient } from '../lib/publish/blob.ts';
import { HTML_CACHE_MAX_AGE } from '../lib/publish/config.ts';
import { appendLogEntry, readLog } from '../lib/publish/log.ts';
import { writeManifest } from '../lib/publish/manifest.ts';
import { toPublicSlug } from '../lib/publish/slug.ts';
import type { LogRow } from '../lib/publish/types.ts';
import { loadEnvFile } from '../lib/secrets/load-env.ts';

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: { 'dry-run': { type: 'boolean', default: false } },
    strict: true,
  });
  const dryRun = values['dry-run'] ?? false;

  const userData = resolveUserDataDir();
  loadEnvFile(userData);
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  const userId = process.env.PUBLISH_USER_ID;
  const publicUrl = process.env.PUBLISH_PUBLIC_URL || 'https://askrobin.io';
  const blobBase = process.env.BLOB_PUBLIC_BASE_URL;
  const urlSecret = process.env.PUBLISH_URL_SECRET;
  if (!token || !userId || !blobBase || !urlSecret) {
    console.error(
      'missing env: need BLOB_READ_WRITE_TOKEN, PUBLISH_USER_ID, BLOB_PUBLIC_BASE_URL, PUBLISH_URL_SECRET',
    );
    process.exit(3);
  }

  const logPath = join(userData, 'observability', 'publish', 'index.jsonl');
  const blob = createBlobClient({ token });

  const { entries } = await readLog(logPath);
  // Latest row per slug; live = latest action !== 'delete'.
  const latestBySlug = new Map<string, LogRow>();
  for (const e of entries) {
    const cur = latestBySlug.get(e.slug);
    if (!cur || e.ts >= cur.ts) latestBySlug.set(e.slug, e);
  }
  const live = [...latestBySlug.values()].filter((e) => e.action !== 'delete');

  // Every live base slug → hashed slug, for link rewriting.
  const hashedBySlug = new Map<string, string>();
  for (const e of live) hashedBySlug.set(e.slug, toPublicSlug(userId, e.slug, urlSecret));

  const linkRe = new RegExp(`(/@${userId}/)([a-z0-9-]{1,80})`, 'g');
  const rewriteLinks = (html: string): string =>
    html.replace(linkRe, (whole, prefix: string, slug: string) => {
      const hashed = hashedBySlug.get(slug);
      return hashed ? `${prefix}${hashed}` : whole; // unknown/already-hashed → untouched
    });

  let moved = 0;
  let skipped = 0;
  let failed = 0;

  for (const row of live) {
    const hashed = hashedBySlug.get(row.slug) ?? toPublicSlug(userId, row.slug, urlSecret);
    const oldKey = `users/${userId}/pages/${row.slug}/index.html`;
    const newKey = `users/${userId}/pages/${hashed}/index.html`;

    if (row.blob_key === newKey) {
      skipped++;
      continue; // already migrated
    }

    const res = await fetch(`${blobBase}/${oldKey}`);
    if (res.status === 404) {
      const { exists } = await blob.headBlob(newKey);
      console.warn(
        `[warn] ${row.slug}: old blob missing${exists ? ' (new key already exists)' : ''}`,
      );
      if (exists) skipped++;
      else failed++;
      continue;
    }
    if (!res.ok) {
      console.error(`[fail] ${row.slug}: fetch ${res.status}`);
      failed++;
      continue;
    }
    const html = rewriteLinks(await res.text());

    if (dryRun) {
      console.log(`[dry] ${row.slug} → ${hashed}`);
      moved++;
      continue;
    }

    await blob.putBlob(newKey, html, {
      contentType: 'text/html; charset=utf-8',
      cacheControlMaxAge: HTML_CACHE_MAX_AGE,
      allowOverwrite: true,
      access: 'public',
    });
    const { exists } = await blob.headBlob(newKey);
    if (!exists) {
      console.error(`[fail] ${row.slug}: new blob missing after put`);
      failed++;
      continue;
    }
    await blob.delBlob(oldKey);

    await appendLogEntry(logPath, {
      ts: new Date().toISOString(),
      action: 'overwrite',
      slug: row.slug,
      url: `${publicUrl}/@${userId}/${hashed}`,
      user_id: userId,
      source: row.source,
      blob_key: newKey,
      title: row.title,
      assets: Array.isArray(row.assets) ? row.assets : [],
      warnings: ['migrated to hashed url 2026-08-19'],
      category: row.category,
      description: row.description ?? null,
    });
    moved++;
    console.log(`[ok] ${row.slug} → ${hashed}`);
  }

  if (!dryRun) {
    const { entries: updated } = await readLog(logPath);
    await writeManifest(blob, { publicUrl, userId, urlSecret }, updated);
    console.log('manifest rebuilt');
  }

  console.log(
    `done: ${moved} moved, ${skipped} skipped, ${failed} failed (of ${live.length} live)`,
  );
  if (failed > 0) process.exit(4);
}

await main();
