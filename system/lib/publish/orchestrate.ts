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
import { walkLocalImages } from './images.ts';
import { appendLogEntry, readLog } from './log.ts';
import { writeManifest } from './manifest.ts';
import { extractFrontmatter, normalizeMarkdown, sanitizeSchema } from './pipeline.ts';
import { appendSuffix, deriveSlug, isRefusedSlug, sanitizeSlug } from './slug.ts';
import { wrapHtml } from './template.ts';
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
import { classify } from './categories.ts';

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

/** Canonical public URL for a published page: `${publicUrl}/@<user>/<slug>`. */
function pageUrl(env: PublishEnv, slug: string): string {
  return `${env.publicUrl}/@${env.userId}/${slug}`;
}

function extractFirstH1(body: string): string | null {
  const m = body.match(/^#\s+(.+?)\s*$/m);
  return m ? m[1] : null;
}

function rewriteDeterministicUrls(tree: MdastRoot, blobPublicBaseUrl: string): void {
  walkAst(tree as unknown as AstNode, (node) => {
    if (
      node.type === 'image' &&
      typeof node.url === 'string' &&
      node.url.startsWith('RESOLVE_DETERMINISTIC:')
    ) {
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
      privateBlobClient: opts.privateBlobClient,
      logPath: opts.logPath,
      telemetryPath: opts.telemetryPath,
    });
  }

  if (!opts.source) throw new PublishError(EXIT_INPUT, `source required for mode=${mode}`);

  const absSource = isAbsolute(opts.source) ? opts.source : resolve(opts.source);
  const raw = await loadSource(absSource);

  const { frontmatter, body: bodyRaw } = extractFrontmatter(raw);
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
  const { category, visibility } = classification;
  warnings.push(...classification.warnings);

  const privateClient = opts.privateBlobClient ?? null;
  if (visibility === 'private' && !privateClient) {
    throw new PublishError(
      EXIT_POLICY,
      'Refused: visibility:private requires a private blob store — set BLOB_PRIVATE_READ_WRITE_TOKEN in user-data/config/secrets/.env',
    );
  }
  const pageClient = visibility === 'private' ? privateClient! : opts.blobClient;

  let body = normalizeMarkdown(bodyRaw);
  const stripped = stripUntrustedBlocks(body);
  body = stripped.body;
  if (stripped.removed) warnings.push(`stripped ${stripped.removed} UNTRUSTED block(s)`);
  if (!body.trim()) throw new PublishError(EXIT_INPUT, 'no content to publish (markdown is empty)');

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

  const pagePrefix = visibility === 'private' ? 'private' : 'pages';
  const htmlKeyFor = (s: string): string =>
    `users/${opts.env.userId}/${pagePrefix}/${s}/index.html`;

  if (action !== 'overwrite') {
    const baseSlug = slug;
    let candidate = action === 'as-new' ? appendSuffix(baseSlug) : slug;
    let attempts = 0;
    let found = false;
    while (attempts < COLLISION_RETRY_LIMIT) {
      const { exists } = await pageClient.headBlob(htmlKeyFor(candidate));
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

  const mdParser = unified().use(remarkParse).use(remarkGfm);
  const mdast = mdParser.parse(body) as unknown as MdastRoot;

  const sourceDir = dirname(absSource);
  const { assetKeys, warnings: imgWarnings } = dryRun
    ? { assetKeys: [], warnings: [] }
    : await walkLocalImages({
        tree: mdast,
        sourceDir,
        slug,
        userId: opts.env.userId,
        blobClient: opts.blobClient,
      });
  warnings.push(...imgWarnings);

  rewriteDeterministicUrls(mdast, opts.env.blobPublicBaseUrl);

  const htmlProcessor = unified()
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypeRaw)
    .use(rehypeSlug)
    // biome-ignore lint/suspicious/noExplicitAny: rehype-sanitize schema type is loose
    .use(rehypeSanitize, sanitizeSchema as any)
    .use(rehypeStringify);

  const hast = await htmlProcessor.run(mdast);
  const bodyHtml = String(htmlProcessor.stringify(hast));

  const fmTitle = frontmatter.title;
  const title =
    (typeof fmTitle === 'string' && fmTitle) ||
    extractFirstH1(body) ||
    basename(absSource).replace(/\.[^.]+$/, '');
  const fmDesc = frontmatter.description;
  const description = typeof fmDesc === 'string' ? fmDesc : null;

  const fullHtml = wrapHtml({
    title,
    description,
    slug,
    bodyHtml,
    dateUtc: nowUtcDate(),
    publicBaseUrl: opts.env.publicUrl,
  });

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

  await pageClient.putBlob(htmlKey, fullHtml, {
    contentType: 'text/html; charset=utf-8',
    cacheControlMaxAge: HTML_CACHE_MAX_AGE,
    allowOverwrite: action === 'overwrite',
    access: visibility === 'private' ? 'private' : 'public',
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
    visibility,
    description,
  };
  try {
    await appendLogEntry(opts.logPath, logRow);
  } catch (err) {
    warnings.push(`log append failed: ${(err as Error).message}`);
  }
  // Visibility flip: if this slug existed at the opposite-visibility prefix,
  // remove that stale blob so a now-private page can't linger at a public URL
  // (and vice versa).
  try {
    const { entries: priorEntries } = await readLog(opts.logPath);
    const prior = [...priorEntries]
      .reverse()
      .find((e) => e.slug === slug && e.action !== 'delete' && e.blob_key !== htmlKey);
    const priorVisibility = prior?.visibility ?? 'public';
    const priorClient = priorVisibility === 'private' ? privateClient : opts.blobClient;
    if (priorClient && prior?.blob_key && priorVisibility !== visibility) {
      await priorClient.delBlob(prior.blob_key).catch(() => null);
    }
  } catch {
    // best-effort cleanup
  }
  // Rebuild + write the per-user index manifest after the page blob is
  // committed. Best-effort: a manifest failure must never fail the publish —
  // the next publish's full rebuild repairs it.
  try {
    const { entries } = await readLog(opts.logPath);
    await writeManifest(opts.blobClient, opts.env, entries, privateClient);
  } catch (err) {
    warnings.push(`manifest write failed: ${(err as Error).message}`);
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
  privateBlobClient?: BlobClient | null;
  logPath: string;
  telemetryPath: string;
}

async function runDelete(input: DeleteInput): Promise<PublishResult> {
  const t0 = Date.now();
  if (!input.slug) throw new PublishError(EXIT_INPUT, '--slug required for mode=delete');
  const slug = sanitizeSlug(input.slug);
  if (!slug) throw new PublishError(EXIT_INPUT, 'invalid slug');

  // Read the log first so we can pick the right client/prefix for the page blob.
  const { entries } = await readLog(input.logPath);
  const latest = [...entries].reverse().find((e) => e.slug === slug && Array.isArray(e.assets));

  const priorVisibility =
    latest?.visibility ?? (latest?.blob_key?.includes('/private/') ? 'private' : 'public');
  const pageClient =
    priorVisibility === 'private' && input.privateBlobClient
      ? input.privateBlobClient
      : input.blobClient;

  const pagePrefix = priorVisibility === 'private' ? 'private' : 'pages';
  const htmlKey =
    latest?.blob_key ?? `users/${input.env.userId}/${pagePrefix}/${slug}/index.html`;

  const { exists } = await pageClient.headBlob(htmlKey);

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

  const assetsToDelete = latest?.assets ?? [];

  for (const k of assetsToDelete) {
    await input.blobClient.delBlob(k).catch(() => null);
  }
  await pageClient.delBlob(htmlKey);

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
  // Refresh the per-user manifest so the deleted slug drops off the index.
  try {
    const { entries: updatedEntries } = await readLog(input.logPath);
    await writeManifest(input.blobClient, input.env, updatedEntries, input.privateBlobClient ?? null);
  } catch {
    // best-effort; next publish repairs it
  }
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
