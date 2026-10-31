import { readFile, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import type { Root as MdastRoot } from 'mdast';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize from 'rehype-sanitize';
import rehypeSlug from 'rehype-slug';
import rehypeStringify from 'rehype-stringify';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import { unified } from 'unified';
import { classify } from './categories.ts';
import {
  COLLISION_RETRY_LIMIT,
  EXIT_INPUT,
  EXIT_POLICY,
  EXIT_UPSTREAM,
  HTML_CACHE_MAX_AGE,
  MARKDOWN_SOURCE_MAX_BYTES,
  PAGE_PAYLOAD_REFUSE_BYTES,
  PAGE_PAYLOAD_WARN_BYTES,
  RESERVED_SLUG_PREFIX,
  SLUG_MAX_LENGTH,
} from './config.ts';
import { checkPublishDiscretion } from './discretion.ts';
import { collectMarkdownAttachmentRefs, type LinkRef, uploadAttachments } from './files.ts';
import { type ImageRef, isHtmlSource, readHtmlMeta, renderHtmlPage } from './html-page.ts';
import { walkLocalImages } from './images.ts';
import { appendLogEntry, readLog } from './log.ts';
import { extractFrontmatter, normalizeMarkdown, sanitizeSchema } from './pipeline.ts';
import { appendSuffix, deriveSlug, isRefusedSlug, sanitizeSlug, toPublicSlug } from './slug.ts';
import { wrapHtml } from './template.ts';
import { dropThumb, updateThumbs } from './thumbs.ts';
import type {
  BlobClient,
  LogRow,
  PublishAction,
  PublishEnv,
  PublishOptions,
  PublishResult,
  TelemetryRow,
} from './types.ts';
import { shouldRefuseUntrusted, stripUntrustedBlocks } from './untrusted.ts';

export class PublishError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.name = 'PublishError';
    this.code = code;
  }
}

function nowUtcDate(): string {
  return new Date().toISOString().slice(0, 10);
}
function nowIsoMs(): string {
  return new Date().toISOString();
}

/**
 * Canonical public URL for a published page:
 * `${publicUrl}/@<user>/<slug>-<hash>`. The hash makes the URL unguessable —
 * pages are unlisted; only the password-gated index links to them.
 */
function pageUrl(env: PublishEnv, slug: string): string {
  return `${env.publicUrl}/@${env.userId}/${toPublicSlug(env.userId, slug, env.urlSecret)}`;
}

function extractFirstH1(body: string): string | null {
  const m = body.match(/^#\s+(.+?)\s*$/m);
  return m ? m[1] : null;
}

/**
 * Rewrite markdown links that point at this user's own published pages so they
 * target the hashed (unguessable) URL. Source docs keep plain
 * `/@<user>/<slug>` links; the hash is applied here at publish time.
 * Idempotent via toPublicSlug, so already-hashed links pass through unchanged.
 */
function rewriteInternalHref(url: string, env: PublishEnv): string {
  for (const prefix of [`${env.publicUrl}/@${env.userId}/`, `/@${env.userId}/`]) {
    if (!url.startsWith(prefix)) continue;
    const m = url.slice(prefix.length).match(/^([a-z0-9-]+)([/#?].*)?$/);
    if (!m) return url;
    return `${prefix}${toPublicSlug(env.userId, m[1], env.urlSecret)}${m[2] ?? ''}`;
  }
  return url;
}

function rewriteInternalPageLinks(tree: MdastRoot, env: PublishEnv): void {
  walkAst(tree as unknown as AstNode, (node) => {
    if ((node.type !== 'link' && node.type !== 'definition') || typeof node.url !== 'string')
      return;
    node.url = rewriteInternalHref(node.url, env);
  });
}

function rewriteDeterministicUrls(tree: MdastRoot, blobPublicBaseUrl: string): void {
  // Images and attachment links (link/definition) both carry these markers.
  walkAst(tree as unknown as AstNode, (node) => {
    if (typeof node.url === 'string' && node.url.startsWith('RESOLVE_DETERMINISTIC:')) {
      const key = node.url.slice('RESOLVE_DETERMINISTIC:'.length);
      node.url = `${blobPublicBaseUrl}/${key}`;
    }
  });
}

interface AstNode {
  type: string;
  url?: string;
  children?: AstNode[];
}

function walkAst(node: AstNode, visit: (n: AstNode) => void): void {
  visit(node);
  for (const child of node.children ?? []) walkAst(child, visit);
}

async function loadSource(source: string): Promise<string> {
  const st = await stat(source).catch(() => null);
  if (!st) throw new PublishError(EXIT_INPUT, `source not found: ${source}`);
  if (st.isDirectory()) throw new PublishError(EXIT_INPUT, 'source is a directory; specify a file');
  if (st.size > MARKDOWN_SOURCE_MAX_BYTES) {
    throw new PublishError(EXIT_INPUT, `source exceeds ${MARKDOWN_SOURCE_MAX_BYTES} bytes`);
  }
  return readFile(source, 'utf8');
}

function htmlFrontmatter(raw: string): { frontmatter: Record<string, unknown>; body: string } {
  const meta = readHtmlMeta(raw);
  const frontmatter: Record<string, unknown> = {};
  if (meta.title) frontmatter.title = meta.title;
  if (meta.description) frontmatter.description = meta.description;
  if (meta.category) frontmatter.category = meta.category;
  if (meta.trust) frontmatter.trust = meta.trust;
  if (meta.slug) frontmatter.slug = meta.slug;
  // Only the first <h1> matters downstream (title + slug fallbacks).
  return { frontmatter, body: meta.firstH1 ? `# ${meta.firstH1}\n` : '' };
}

/**
 * Upload an HTML page's local <img> sources through the same path markdown
 * images take: wrap each ref as an mdast image node, let walkLocalImages
 * upload + rewrite it, then resolve deterministic (already-uploaded) keys.
 */
async function uploadHtmlImages(
  refs: ImageRef[],
  ctx: { absSource: string; slug: string; env: PublishEnv; blobClient: BlobClient },
): Promise<{ assetKeys: string[]; warnings: string[] }> {
  const nodes = refs.map((r) => ({ type: 'image', url: r.url }));
  const tree = { type: 'root', children: nodes } as unknown as MdastRoot;
  const result = await walkLocalImages({
    tree,
    sourceDir: dirname(ctx.absSource),
    slug: ctx.slug,
    userId: ctx.env.userId,
    blobClient: ctx.blobClient,
  });
  rewriteDeterministicUrls(tree, ctx.env.blobPublicBaseUrl);
  refs.forEach((r, i) => {
    r.url = nodes[i].url;
  });
  return result;
}

async function uploadHtmlAttachments(
  refs: LinkRef[],
  ctx: { absSource: string; slug: string; env: PublishEnv; blobClient: BlobClient },
): Promise<{ assetKeys: string[]; warnings: string[] }> {
  const result = await uploadAttachments({
    refs,
    sourceDir: dirname(ctx.absSource),
    slug: ctx.slug,
    userId: ctx.env.userId,
    blobClient: ctx.blobClient,
  });
  for (const r of refs) {
    if (r.url.startsWith('RESOLVE_DETERMINISTIC:')) {
      r.url = `${ctx.env.blobPublicBaseUrl}/${r.url.slice('RESOLVE_DETERMINISTIC:'.length)}`;
    }
  }
  return result;
}

interface RenderMarkdownInput {
  body: string;
  absSource: string;
  slug: string;
  dryRun: boolean;
  env: PublishEnv;
  blobClient: BlobClient;
}

async function renderMarkdownBody(
  input: RenderMarkdownInput,
): Promise<{ bodyHtml: string; assetKeys: string[]; warnings: string[] }> {
  const mdParser = unified().use(remarkParse).use(remarkGfm);
  const mdast = mdParser.parse(input.body) as unknown as MdastRoot;

  const { assetKeys, warnings } = input.dryRun
    ? { assetKeys: [], warnings: [] }
    : await walkLocalImages({
        tree: mdast,
        sourceDir: dirname(input.absSource),
        slug: input.slug,
        userId: input.env.userId,
        blobClient: input.blobClient,
      });
  const attachmentRefs = collectMarkdownAttachmentRefs(mdast);
  if (attachmentRefs.length && input.dryRun) {
    warnings.push(`${attachmentRefs.length} local attachment link(s) not uploaded (dry run)`);
  } else if (attachmentRefs.length) {
    const files = await uploadAttachments({
      refs: attachmentRefs,
      sourceDir: dirname(input.absSource),
      slug: input.slug,
      userId: input.env.userId,
      blobClient: input.blobClient,
    });
    assetKeys.push(...files.assetKeys);
    warnings.push(...files.warnings);
  }

  rewriteDeterministicUrls(mdast, input.env.blobPublicBaseUrl);
  rewriteInternalPageLinks(mdast, input.env);

  const htmlProcessor = unified()
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypeRaw)
    .use(rehypeSlug)
    // biome-ignore lint/suspicious/noExplicitAny: rehype-sanitize schema type is loose
    .use(rehypeSanitize, sanitizeSchema as any)
    .use(rehypeStringify);

  const hast = await htmlProcessor.run(mdast);
  return { bodyHtml: String(htmlProcessor.stringify(hast)), assetKeys, warnings };
}

function refuseIfSensitive(d: ReturnType<typeof checkPublishDiscretion>): void {
  if (d.ok) return;
  throw new PublishError(
    EXIT_POLICY,
    `Refused: page contains a ${d.reason.replace(/^(pii|secret):/, '$1 shape: ')}. ` +
      'Published pages are readable by anyone with the URL. Remove it from the source, or ' +
      're-run with --allow-sensitive if this is a false positive.',
  );
}

/**
 * Every asset key a slug has carried since its last delete. Asset keys are
 * content-hashed, so an edited image/preset lands at a new key and the old
 * one would otherwise live in blob forever.
 */
function slugAssetHistory(entries: LogRow[], slug: string): Set<string> {
  const keys = new Set<string>();
  for (const e of entries) {
    if (e.slug !== slug) continue;
    if (e.action === 'delete') keys.clear();
    else for (const k of e.assets ?? []) keys.add(k);
  }
  return keys;
}

export async function publish(opts: PublishOptions): Promise<PublishResult> {
  const t0 = Date.now();
  const warnings: string[] = [];
  const mode = opts.mode ?? 'default';
  const dryRun = opts.dryRun ?? false;
  const forceUntrusted = opts.forceUntrusted ?? false;

  if (mode === 'delete') {
    return runDelete({
      slug: opts.slug ?? null,
      env: opts.env,
      blobClient: opts.blobClient,
      logPath: opts.logPath,
      telemetryPath: opts.telemetryPath,
      dryRun: opts.dryRun ?? false,
      thumbs: !!opts.thumbCapture,
    });
  }

  if (!opts.source) throw new PublishError(EXIT_INPUT, `source required for mode=${mode}`);

  const absSource = isAbsolute(opts.source) ? opts.source : resolve(opts.source);
  const raw = await loadSource(absSource);

  // A standalone .html document carries its metadata in <title>/<meta>; map it
  // onto the frontmatter shape so every policy check below applies unchanged.
  const isHtml = isHtmlSource(absSource);
  const { frontmatter, body: bodyRaw } = isHtml ? htmlFrontmatter(raw) : extractFrontmatter(raw);
  if (shouldRefuseUntrusted(frontmatter, forceUntrusted)) {
    throw new PublishError(
      EXIT_POLICY,
      `Refused: ${opts.source} is marked trust:untrusted. Publishing verbatim would close a prompt-injection loop.\n` +
        'Options:\n' +
        '  1. Copy the parts you want into a new file.\n' +
        '  2. Re-run with --force-untrusted to publish anyway.',
    );
  }

  const classification = classify(frontmatter.category, frontmatter.visibility);
  if (!classification.ok) {
    throw new PublishError(EXIT_POLICY, `Refused: ${classification.error}`);
  }
  const { category } = classification;
  warnings.push(...classification.warnings);

  let body = normalizeMarkdown(bodyRaw);
  if (!isHtml) {
    const stripped = stripUntrustedBlocks(body);
    body = stripped.body;
    if (stripped.removed) warnings.push(`stripped ${stripped.removed} UNTRUSTED block(s)`);
  }
  if (!(isHtml ? raw : body).trim()) {
    throw new PublishError(EXIT_INPUT, 'no content to publish (source is empty)');
  }
  // Discretion pre-check on the source, before anything is uploaded — a
  // refusal after image/attachment uploads would orphan those blobs. The
  // final check below re-runs on the rendered page (inlined local JS).
  if (!opts.allowSensitive) refuseIfSensitive(checkPublishDiscretion(isHtml ? raw : body));

  let slugCandidate: string | null = null;
  if (opts.slug != null && opts.slug !== '') {
    if (opts.slug.length > SLUG_MAX_LENGTH) {
      throw new PublishError(
        EXIT_INPUT,
        `--slug too long: ${opts.slug.length} chars (max ${SLUG_MAX_LENGTH})`,
      );
    }
    if (opts.slug.startsWith(RESERVED_SLUG_PREFIX)) {
      throw new PublishError(
        EXIT_POLICY,
        `--slug starts with reserved prefix '${RESERVED_SLUG_PREFIX}'`,
      );
    }
    const sanitized = sanitizeSlug(opts.slug);
    if (!sanitized) {
      throw new PublishError(
        EXIT_INPUT,
        `--slug "${opts.slug}" is not a valid slug after sanitization`,
      );
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

  // Hard refusal: the daily brief is a private artifact and must never be
  // published to the web. Applies to every non-delete mode and to slugs from
  // either an explicit --slug or a brief-named source file. (mode=delete returns
  // above, so existing briefs remain removable.)
  if (isRefusedSlug(slug)) {
    throw new PublishError(
      EXIT_POLICY,
      `Refused: slug "${slug}" is a private daily brief — the daily brief is never published to the web. ` +
        'Use a different slug if this is unrelated content.',
    );
  }

  let action: PublishAction;
  if (mode === 'overwrite') action = 'overwrite';
  else if (mode === 'as-new') action = 'as-new';
  else if (mode === 'default') action = origin === 'user-specified' ? 'overwrite' : 'append';
  else throw new PublishError(EXIT_INPUT, `unknown mode: ${mode}`);

  // Blob key uses the HASHED slug — the direct blob URL is as unguessable as
  // the served /@<user>/ URL.
  const htmlKeyFor = (s: string): string =>
    `users/${opts.env.userId}/pages/${toPublicSlug(opts.env.userId, s, opts.env.urlSecret)}/index.html`;

  if (action !== 'overwrite') {
    const baseSlug = slug;
    let candidate = action === 'as-new' ? appendSuffix(baseSlug) : slug;
    let attempts = 0;
    let found = false;
    while (attempts < COLLISION_RETRY_LIMIT) {
      const { exists } = await opts.blobClient.headBlob(htmlKeyFor(candidate));
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

  const fmTitle = frontmatter.title;
  const title =
    (typeof fmTitle === 'string' && fmTitle) ||
    extractFirstH1(body) ||
    basename(absSource).replace(/\.[^.]+$/, '');
  const fmDesc = frontmatter.description;
  const description = typeof fmDesc === 'string' ? fmDesc : null;

  let fullHtml: string;
  let assetKeys: string[] = [];
  if (isHtml) {
    const page = await renderHtmlPage({
      raw,
      sourceDir: dirname(absSource),
      rewriteHref: (h) => rewriteInternalHref(h, opts.env),
      uploadLocalImages: dryRun
        ? undefined
        : (refs) =>
            uploadHtmlImages(refs, { absSource, slug, env: opts.env, blobClient: opts.blobClient }),
      uploadLocalFiles: dryRun
        ? undefined
        : (refs) =>
            uploadHtmlAttachments(refs, {
              absSource,
              slug,
              env: opts.env,
              blobClient: opts.blobClient,
            }),
    });
    assetKeys = page.assetKeys;
    warnings.push(...page.warnings);
    fullHtml = page.html;
  } else {
    const rendered = await renderMarkdownBody({
      body,
      absSource,
      slug,
      dryRun,
      env: opts.env,
      blobClient: opts.blobClient,
    });
    assetKeys = rendered.assetKeys;
    warnings.push(...rendered.warnings);
    fullHtml = wrapHtml({
      title,
      description,
      slug: toPublicSlug(opts.env.userId, slug, opts.env.urlSecret),
      userId: opts.env.userId,
      bodyHtml: rendered.bodyHtml,
      dateUtc: nowUtcDate(),
      publicBaseUrl: opts.env.publicUrl,
    });
  }

  const discretion = checkPublishDiscretion(fullHtml);
  if (!opts.allowSensitive) refuseIfSensitive(discretion);
  if (!discretion.ok) warnings.push(`published despite discretion hit (${discretion.reason})`);

  const totalBytes = Buffer.byteLength(fullHtml, 'utf8');
  if (totalBytes > PAGE_PAYLOAD_REFUSE_BYTES) {
    throw new PublishError(EXIT_INPUT, `page payload exceeds ${PAGE_PAYLOAD_REFUSE_BYTES} bytes`);
  }
  if (totalBytes > PAGE_PAYLOAD_WARN_BYTES) {
    warnings.push(`page payload exceeds ${PAGE_PAYLOAD_WARN_BYTES} bytes (warning only)`);
  }

  const htmlKey = htmlKeyFor(slug);
  const resultBase: PublishResult = {
    url: pageUrl(opts.env, slug),
    slug,
    action,
    blob_key: htmlKey,
    asset_count: assetKeys.length,
    warnings,
  };

  if (dryRun) return { ...resultBase, dry_run: true };

  await opts.blobClient.putBlob(htmlKey, fullHtml, {
    contentType: 'text/html; charset=utf-8',
    cacheControlMaxAge: HTML_CACHE_MAX_AGE,
    allowOverwrite: action === 'overwrite',
    access: 'public',
  });

  const logRow: LogRow = {
    ts: nowIsoMs(),
    action,
    slug,
    url: resultBase.url,
    user_id: opts.env.userId,
    source: absSource,
    blob_key: htmlKey,
    title,
    assets: assetKeys,
    warnings,
    category,
    description,
  };
  try {
    await appendLogEntry(opts.logPath, logRow);
  } catch (err) {
    warnings.push(`log append failed: ${(err as Error).message}`);
  }
  // Stale-key cleanup: if this slug's previous publish landed at a different
  // blob key (e.g. published before URL hashing, or after a secret rotation),
  // remove the old blob so the page isn't reachable at two URLs.
  try {
    const { entries: priorEntries } = await readLog(opts.logPath);
    const prior = [...priorEntries]
      .reverse()
      .find(
        (e) =>
          e.slug === slug && e.action !== 'delete' && e.ts !== logRow.ts && e.blob_key !== htmlKey,
      );
    if (prior?.blob_key) {
      await opts.blobClient.delBlob(prior.blob_key).catch(() => null);
    }
    // Assets the page no longer references (edited image → new content hash).
    const current = new Set(assetKeys);
    for (const k of slugAssetHistory(priorEntries, slug)) {
      if (!current.has(k)) await opts.blobClient.delBlob(k).catch(() => null);
    }
  } catch {
    // best-effort cleanup
  }
  // Thumbnail for a page with no photo of its own. Best-effort: a failed
  // screenshot never fails the publish (the backfill mode retries).
  if (opts.thumbCapture) {
    try {
      await updateThumbs({
        env: opts.env,
        blobClient: opts.blobClient,
        logPath: opts.logPath,
        capture: opts.thumbCapture,
        slugs: [slug],
      });
    } catch (err) {
      warnings.push(`thumbnail failed: ${(err as Error).message}`);
    }
  }
  const telemetry: TelemetryRow = {
    ts: logRow.ts,
    slug,
    action,
    source: absSource,
    bytes: totalBytes,
    duration_ms: Date.now() - t0,
    warning_count: warnings.length,
  };
  try {
    await appendLogEntry(opts.telemetryPath, telemetry);
  } catch {
    // best-effort
  }
  return resultBase;
}

interface DeleteInput {
  slug: string | null;
  env: PublishEnv;
  blobClient: BlobClient;
  logPath: string;
  telemetryPath: string;
  /** Report what would be deleted; touch nothing (no blobs or log). */
  dryRun?: boolean;
  /** Also drop the page's screenshot thumbnail. */
  thumbs?: boolean;
}

async function runDelete(input: DeleteInput): Promise<PublishResult> {
  const t0 = Date.now();
  if (!input.slug) throw new PublishError(EXIT_INPUT, '--slug required for mode=delete');
  const slug = sanitizeSlug(input.slug);
  if (!slug) throw new PublishError(EXIT_INPUT, 'invalid slug');

  // The log records the exact blob key each page was written to; fall back to
  // the current hashed-key convention for slugs with no log history.
  const { entries } = await readLog(input.logPath);
  const latest = [...entries].reverse().find((e) => e.slug === slug && Array.isArray(e.assets));

  const htmlKey =
    latest?.blob_key ??
    `users/${input.env.userId}/pages/${toPublicSlug(input.env.userId, slug, input.env.urlSecret)}/index.html`;

  const { exists } = await input.blobClient.headBlob(htmlKey);

  // --dry-run used to be ignored here, so a "dry run" deleted for real.
  if (input.dryRun) {
    return {
      url: pageUrl(input.env, slug),
      slug,
      action: exists ? 'delete' : 'noop',
      blob_key: htmlKey,
      asset_count: exists ? slugAssetHistory(entries, slug).size : 0,
      warnings: [],
      dry_run: true,
    };
  }

  if (!exists) {
    try {
      await appendLogEntry(input.telemetryPath, {
        ts: nowIsoMs(),
        slug,
        action: 'noop',
        source: null,
        bytes: 0,
        duration_ms: Date.now() - t0,
        warning_count: 0,
      });
    } catch {
      // best-effort
    }
    return {
      url: pageUrl(input.env, slug),
      slug,
      action: 'noop',
      blob_key: htmlKey,
      asset_count: 0,
      warnings: [],
    };
  }

  const assetsToDelete = [...slugAssetHistory(entries, slug)];

  for (const k of assetsToDelete) {
    await input.blobClient.delBlob(k).catch(() => null);
  }
  await input.blobClient.delBlob(htmlKey);

  try {
    await appendLogEntry(input.logPath, {
      ts: nowIsoMs(),
      action: 'delete',
      slug,
      url: pageUrl(input.env, slug),
      user_id: input.env.userId,
      source: null,
      blob_key: htmlKey,
      title: null,
      assets: [],
      warnings: [],
    });
  } catch {
    // best-effort
  }
  if (input.thumbs) await dropThumb(input.env, input.blobClient, slug).catch(() => undefined);
  try {
    await appendLogEntry(input.telemetryPath, {
      ts: nowIsoMs(),
      slug,
      action: 'delete',
      source: null,
      bytes: 0,
      duration_ms: Date.now() - t0,
      warning_count: 0,
    });
  } catch {
    // best-effort
  }

  return {
    url: pageUrl(input.env, slug),
    slug,
    action: 'delete',
    blob_key: htmlKey,
    asset_count: assetsToDelete.length,
    warnings: [],
  };
}
