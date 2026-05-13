import { stat, readFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve as resolvePath, basename } from 'node:path';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkRehype from 'remark-rehype';
import rehypeRaw from 'rehype-raw';
import rehypeSlug from 'rehype-slug';
import rehypeSanitize from 'rehype-sanitize';
import rehypeStringify from 'rehype-stringify';
import { extractFrontmatter, normalizeMarkdown, sanitizeSchema } from './pipeline.js';
import { shouldRefuseUntrusted, stripUntrustedBlocks } from './untrusted.js';
import { deriveSlug, sanitizeSlug, appendSuffix } from './slug.js';
import { walkLocalImages } from './images.js';
import { wrapHtml } from './template.js';
import { appendLogEntry, readLog } from './log.js';
import {
  COLLISION_RETRY_LIMIT,
  HTML_CACHE_CONTROL,
  logPath as defaultLogPath,
  telemetryPath as defaultTelemetryPath,
  EXIT_POLICY, EXIT_INPUT, EXIT_UPSTREAM,
  MARKDOWN_SOURCE_MAX_BYTES,
  PAGE_PAYLOAD_REFUSE_BYTES, PAGE_PAYLOAD_WARN_BYTES,
  SLUG_MAX_LENGTH,
  RESERVED_SLUG_PREFIX,
} from './config.js';

export class PublishError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PublishError';
    this.code = code;
  }
}

function nowUtcDate() { return new Date().toISOString().slice(0, 10); }
function nowIsoMs() { return new Date().toISOString(); }

function extractFirstH1(body) {
  const m = body.match(/^#\s+(.+?)\s*$/m);
  return m ? m[1] : null;
}

// Walk an mdast tree and replace RESOLVE_DETERMINISTIC: placeholder URLs
// with real blob URLs using the configured blobPublicBaseUrl.
function rewriteDeterministicUrls(tree, blobPublicBaseUrl) {
  _walkTree(tree, (node) => {
    if (node.type === 'image' && typeof node.url === 'string'
        && node.url.startsWith('RESOLVE_DETERMINISTIC:')) {
      const key = node.url.slice('RESOLVE_DETERMINISTIC:'.length);
      node.url = `${blobPublicBaseUrl}/${key}`;
    }
  });
}

function _walkTree(node, visit) {
  visit(node);
  for (const child of node.children || []) _walkTree(child, visit);
}

async function loadSource(source) {
  const st = await stat(source).catch(() => null);
  if (!st) throw new PublishError(EXIT_INPUT, `source not found: ${source}`);
  if (st.isDirectory()) throw new PublishError(EXIT_INPUT, 'source is a directory; specify a file');
  if (st.size > MARKDOWN_SOURCE_MAX_BYTES) {
    throw new PublishError(EXIT_INPUT, `source exceeds ${MARKDOWN_SOURCE_MAX_BYTES} bytes`);
  }
  return readFile(source, 'utf8');
}

export async function publish({
  source,
  slug: explicitSlug = null,
  mode = 'default',
  forceUntrusted = false,
  dryRun = false,
  env,               // { token, userId, publicUrl, blobPublicBaseUrl, repoRoot }
  blobClient,        // { headBlob, putBlob, delBlob }
  logPath = defaultLogPath(),
  telemetryPath = defaultTelemetryPath(),
}) {
  const t0 = Date.now();
  const warnings = [];

  // Resolve log/telemetry paths relative to repoRoot when not absolute.
  const absLogPath = isAbsolute(logPath) ? logPath : resolvePath(env.repoRoot, logPath);
  const absTelemetryPath = isAbsolute(telemetryPath) ? telemetryPath : resolvePath(env.repoRoot, telemetryPath);

  // --- mode=delete branch ---
  if (mode === 'delete') {
    return runDelete({ slug: explicitSlug, env, blobClient, logPath: absLogPath, telemetryPath: absTelemetryPath });
  }

  if (!source) throw new PublishError(EXIT_INPUT, `source required for mode=${mode}`);

  // 1. Load source
  const absSource = isAbsolute(source) ? source : resolvePath(env.repoRoot, source);
  const raw = await loadSource(absSource);

  // 2. Extract frontmatter + normalize
  const { frontmatter, body: bodyRaw } = extractFrontmatter(raw);

  // 3. Untrusted gate
  if (shouldRefuseUntrusted(frontmatter, forceUntrusted)) {
    throw new PublishError(
      EXIT_POLICY,
      `Refused: ${source} is marked trust:untrusted. Publishing verbatim would close a prompt-injection loop.\n` +
      `Options:\n` +
      `  1. Copy the parts you want into a new file.\n` +
      `  2. Re-run with "publish anyway" / --force-untrusted to publish anyway.`,
    );
  }

  let body = normalizeMarkdown(bodyRaw);

  // 4. Strip UNTRUSTED blocks
  const stripped = stripUntrustedBlocks(body);
  body = stripped.body;
  if (stripped.removed) warnings.push(`stripped ${stripped.removed} UNTRUSTED block(s)`);

  if (!body.trim()) throw new PublishError(EXIT_INPUT, 'no content to publish (markdown is empty)');

  // 5. Derive slug
  // If user passed an explicit --slug, validate it; reject rather than silently
  // falling through the cascade if the value is invalid.
  let slugCandidate = null;
  if (explicitSlug != null && explicitSlug !== '') {
    if (explicitSlug.length > SLUG_MAX_LENGTH) {
      throw new PublishError(EXIT_INPUT, `--slug too long: ${explicitSlug.length} chars (max ${SLUG_MAX_LENGTH})`);
    }
    if (explicitSlug.startsWith(RESERVED_SLUG_PREFIX)) {
      throw new PublishError(EXIT_POLICY, `--slug starts with reserved prefix '${RESERVED_SLUG_PREFIX}'`);
    }
    const sanitized = sanitizeSlug(explicitSlug);
    if (!sanitized) {
      throw new PublishError(EXIT_INPUT, `--slug "${explicitSlug}" is not a valid slug after sanitization`);
    }
    slugCandidate = sanitized;
  }
  const { slug: derivedSlug, origin } = deriveSlug({
    explicit: slugCandidate,
    source: absSource,
    isDirectory: false,
    body,
    frontmatter,
  });
  let slug = derivedSlug;

  // 6. Mode resolution
  let action;
  if (mode === 'overwrite') {
    action = 'overwrite';
  } else if (mode === 'as-new') {
    action = 'as-new';
  } else if (mode === 'default') {
    // User-specified slug → overwrite; Robin-derived → find an unused slot (append suffix).
    action = origin === 'user-specified' ? 'overwrite' : 'append';
  } else {
    throw new PublishError(EXIT_INPUT, `unknown mode: ${mode}`);
  }

  // 7. Collision check — loop on suffix until a free slot is found (cap at COLLISION_RETRY_LIMIT).
  const htmlKeyFor = (s) => `users/${env.userId}/pages/${s}/index.html`;

  if (action !== 'overwrite') {
    const baseSlug = slug;
    // as-new always generates a unique slug by starting with a suffix immediately.
    let candidate = action === 'as-new' ? appendSuffix(baseSlug) : slug;
    let attempts = 0;
    let found = false;

    while (attempts < COLLISION_RETRY_LIMIT) {
      const { exists } = await blobClient.headBlob(htmlKeyFor(candidate));
      if (!exists) {
        slug = candidate;
        found = true;
        break;
      }
      candidate = appendSuffix(baseSlug);
      attempts += 1;
    }

    if (!found) {
      throw new PublishError(
        EXIT_UPSTREAM,
        `slug-exhausted: ${COLLISION_RETRY_LIMIT} collision retries failed`,
      );
    }
  }

  // 8. Parse markdown to mdast
  const mdParser = unified().use(remarkParse).use(remarkGfm);
  const mdast = mdParser.parse(body);

  // 9. Walk local images — uploads assets, rewrites node.url in place.
  //    Skip uploads in dry-run mode; asset_count will reflect 0 but no network I/O occurs.
  const sourceDir = dirname(absSource);
  const { assetKeys, warnings: imgWarnings } = dryRun
    ? { assetKeys: [], warnings: [] }
    : await walkLocalImages({
        tree: mdast,
        sourceDir,
        slug,
        userId: env.userId,
        blobClient,
      });
  warnings.push(...imgWarnings);

  // 10. Rewrite RESOLVE_DETERMINISTIC: placeholder URLs to real blob URLs
  rewriteDeterministicUrls(mdast, env.blobPublicBaseUrl);

  // 11. Transform mdast → hast → sanitize → stringify
  // We already parsed mdast above with mdParser; this processor only runs
  // the transformer chain (remarkRehype → rehype-raw → slug → sanitize → stringify).
  const htmlProcessor = unified()
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypeRaw)
    .use(rehypeSlug)
    .use(rehypeSanitize, sanitizeSchema)
    .use(rehypeStringify);

  const hast = await htmlProcessor.run(mdast);
  const bodyHtml = String(htmlProcessor.stringify(hast));

  // 12. Derive title + description
  const title = frontmatter.title
    || extractFirstH1(body)
    || basename(absSource).replace(/\.[^.]+$/, '');
  const description = frontmatter.description ?? null;

  // 13. Wrap in HTML template
  const fullHtml = wrapHtml({
    title,
    description,
    slug,
    bodyHtml,
    dateUtc: nowUtcDate(),
    publicBaseUrl: env.publicUrl,
  });

  // 14. Page payload size guard
  const totalBytes = Buffer.byteLength(fullHtml, 'utf8');
  if (totalBytes > PAGE_PAYLOAD_REFUSE_BYTES) {
    throw new PublishError(EXIT_INPUT, `page payload exceeds ${PAGE_PAYLOAD_REFUSE_BYTES} bytes`);
  }
  if (totalBytes > PAGE_PAYLOAD_WARN_BYTES) {
    warnings.push(`page payload exceeds ${PAGE_PAYLOAD_WARN_BYTES} bytes (warning only)`);
  }

  // 15. Normalize action name for result (append is internal; callers see 'create')
  const finalAction = action === 'overwrite' ? 'overwrite' : 'create';

  const htmlKey = htmlKeyFor(slug);
  const resultBase = {
    url: `${env.publicUrl}/p/${slug}`,
    slug,
    action: finalAction,
    blob_key: htmlKey,
    asset_count: assetKeys.length,
    warnings,
  };

  // 16. Dry-run: return without uploading
  if (dryRun) {
    return { ...resultBase, dry_run: true };
  }

  // 17. Upload HTML LAST (assets already uploaded by walkLocalImages)
  await blobClient.putBlob(htmlKey, fullHtml, {
    contentType: 'text/html; charset=utf-8',
    cacheControl: HTML_CACHE_CONTROL,
    allowOverwrite: action === 'overwrite',
  });

  // 18. Append log entry (best-effort: failure adds warning but doesn't fail publish)
  const logRow = {
    ts: nowIsoMs(),
    action: finalAction,
    slug,
    url: resultBase.url,
    user_id: env.userId,
    source: absSource,
    blob_key: htmlKey,
    title,
    assets: assetKeys,
    warnings,
  };
  try {
    await appendLogEntry(absLogPath, logRow);
  } catch (e) {
    warnings.push(`log append failed: ${e.message}`);
  }

  // 19. Append telemetry entry (best-effort: ignored on failure)
  try {
    await appendLogEntry(absTelemetryPath, {
      ts: logRow.ts,
      slug,
      action: finalAction,
      source: absSource,
      bytes: totalBytes,
      duration_ms: Date.now() - t0,
      warning_count: warnings.length,
    });
  } catch { /* telemetry is best-effort */ }

  return resultBase;
}

async function runDelete({ slug: explicitSlug, env, blobClient, logPath, telemetryPath }) {
  const t0 = Date.now();
  if (!explicitSlug) throw new PublishError(EXIT_INPUT, '--slug required for mode=delete');
  const slug = sanitizeSlug(explicitSlug);
  if (!slug) throw new PublishError(EXIT_INPUT, 'invalid slug');

  const htmlKey = `users/${env.userId}/pages/${slug}/index.html`;
  const { exists } = await blobClient.headBlob(htmlKey);

  if (!exists) {
    if (telemetryPath) {
      try {
        await appendLogEntry(telemetryPath, {
          ts: nowIsoMs(),
          slug,
          action: 'noop',
          source: null,
          bytes: 0,
          duration_ms: Date.now() - t0,
          warning_count: 0,
        });
      } catch { /* best-effort */ }
    }
    return {
      url: `${env.publicUrl}/p/${slug}`,
      slug,
      action: 'noop',
      blob_key: htmlKey,
      asset_count: 0,
      warnings: [],
    };
  }

  // Find the most recent log entry for this slug to get its asset list.
  const { entries } = await readLog(logPath);
  const latest = [...entries].reverse().find((e) => e.slug === slug && Array.isArray(e.assets));
  const assetsToDelete = latest?.assets || [];

  // Delete assets first, then the HTML page.
  for (const k of assetsToDelete) {
    await blobClient.delBlob(k).catch(() => null);
  }
  await blobClient.delBlob(htmlKey);

  // Append delete log row (best-effort).
  try {
    await appendLogEntry(logPath, {
      ts: nowIsoMs(),
      action: 'delete',
      slug,
      url: `${env.publicUrl}/p/${slug}`,
      user_id: env.userId,
      source: null,
      blob_key: htmlKey,
      title: null,
      assets: [],
      warnings: [],
    });
  } catch { /* log failure doesn't fail delete */ }

  // Append telemetry entry (best-effort).
  if (telemetryPath) {
    try {
      await appendLogEntry(telemetryPath, {
        ts: nowIsoMs(),
        slug,
        action: 'delete',
        source: null,
        bytes: 0,
        duration_ms: Date.now() - t0,
        warning_count: 0,
      });
    } catch { /* best-effort */ }
  }

  return {
    url: `${env.publicUrl}/p/${slug}`,
    slug,
    action: 'delete',
    blob_key: htmlKey,
    asset_count: assetsToDelete.length,
    warnings: [],
  };
}
