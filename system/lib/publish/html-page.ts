import { readFile, realpath } from 'node:fs/promises';
import { extname, isAbsolute, relative } from 'node:path';
import rehypeParse from 'rehype-parse';
import rehypeStringify from 'rehype-stringify';
import { unified } from 'unified';
import { INLINE_ASSET_MAX_BYTES, PAGE_SCRIPT_HOSTS, PAGE_STYLE_HOSTS } from './config.ts';
import { isLocalAttachmentUrl } from './files.ts';
import { resolveLocalPath } from './images.ts';
import { stripUntrustedBlocks } from './untrusted.ts';

/**
 * Standalone HTML pages — the default publish format. A source file that is
 * already a complete document (its own <head>, <style>, <script>, layout)
 * publishes as itself instead of being wrapped in the markdown template.
 * Metadata comes from the document:
 *
 *   <title>                         → page title
 *   <meta name="description">       → index one-liner
 *   <meta name="robin:category">    → category (same taxonomy as frontmatter)
 *   <meta name="robin:trust">       → same refusal rule as frontmatter `trust:`
 *   <meta name="robin:slug">        → slug (same as frontmatter `slug:`)
 *
 * JavaScript runs (decision 2026-10-26). The security boundary is the serving
 * CSP, not this module: the publish host serves every page with
 * `sandbox allow-scripts` (opaque origin) and a host allowlist (PAGE_SCRIPT_HOSTS /
 * PAGE_STYLE_HOSTS). A page that carries the STORAGE_MARKER meta is served with
 * `allow-same-origin` added, so localStorage / IndexedDB work (decision
 * 2026-11-12: a page can record its reader's actions). Only this module writes
 * that marker (author robin:* metas are always dropped): see storageDecision. The
 * direct blob URL is served as an attachment with `default-src 'none'`, so
 * script never runs there. An allowlist sanitizer on top would only break
 * legitimate pages, so this module does targeted rewrites instead:
 *
 *   - robin:* directives and any author robots meta removed; one noindex forced
 *   - <base> and <meta http-equiv> removed (URL hijack / refresh redirect)
 *   - UNTRUSTED blocks stripped; internal page links hashed
 *   - local <img>, attachment links uploaded; local <script src>/<link
 *     rel=stylesheet> inlined (blob-hosted JS/CSS would be CSP-blocked)
 *   - everything the serving CSP will block is reported as a warning —
 *     off-list script/style hosts, cross-origin iframes, form posts, plugins,
 *     eval
 *   - the storage marker added when the page's scripts use storage (and it
 *     handles no unlock key)
 */

// Minimal hast shapes — enough for metadata reads and in-place rewrites.
interface HastNodes {
  type: string;
  value?: string;
  children?: HastNodes[];
}
interface Element extends HastNodes {
  type: 'element';
  tagName: string;
  properties: Record<string, unknown>;
  children: HastNodes[];
}
type HastRoot = HastNodes;

export function isHtmlSource(path: string): boolean {
  return /\.html?$/i.test(path);
}

export interface HtmlPageMeta {
  title: string | null;
  description: string | null;
  category: string | null;
  trust: string | null;
  slug: string | null;
  firstH1: string | null;
}

export interface RenderedHtmlPage {
  html: string;
  meta: HtmlPageMeta;
  assetKeys: string[];
  warnings: string[];
}

/** A local image/attachment reference; the uploader rewrites `url` in place. */
export interface ImageRef {
  url: string;
}

export type UploadLocalImages = (
  refs: ImageRef[],
) => Promise<{ assetKeys: string[]; warnings: string[] }>;

function textOf(node: HastNodes): string {
  if (node.type === 'text') return node.value ?? '';
  return (node.children ?? []).map(textOf).join('');
}

function walk(node: HastNodes, visit: (el: Element, parent: HastNodes) => void): void {
  for (const c of node.children ?? []) {
    if (c.type === 'element') visit(c as Element, node);
    walk(c, visit);
  }
}

function metaName(el: Element): string {
  return String(el.properties?.name ?? '').toLowerCase();
}

function isCrossOrigin(url: string): boolean {
  return /^(https?:)?\/\//i.test(url);
}

function onHosts(url: string, hosts: readonly string[]): boolean {
  const abs = url.startsWith('//') ? `https:${url}` : url;
  return hosts.some((h) => abs === h || abs.startsWith(`${h}/`));
}

function isLocalSrc(src: string): boolean {
  return !/^([a-z][a-z0-9+.-]*:|\/\/|\/|#)/i.test(src) || /^file:/i.test(src);
}

function readMeta(tree: HastRoot): HtmlPageMeta {
  const meta: HtmlPageMeta = {
    title: null,
    description: null,
    category: null,
    trust: null,
    slug: null,
    firstH1: null,
  };
  walk(tree, (el) => {
    if (el.tagName === 'title' && meta.title == null) meta.title = textOf(el).trim() || null;
    if (el.tagName === 'h1' && meta.firstH1 == null) meta.firstH1 = textOf(el).trim() || null;
    if (el.tagName !== 'meta') return;
    const content = el.properties?.content;
    if (typeof content !== 'string') return;
    const name = metaName(el);
    if (name === 'description') meta.description = content.trim() || null;
    else if (name === 'robin:category') meta.category = content.trim() || null;
    else if (name === 'robin:trust') meta.trust = content.trim() || null;
    else if (name === 'robin:slug') meta.slug = content.trim() || null;
  });
  return meta;
}

function parse(raw: string): HastRoot {
  return unified().use(rehypeParse).parse(raw) as unknown as HastRoot;
}

/** Parse a source document and read its Robin metadata (no rewriting). */
export function readHtmlMeta(raw: string): HtmlPageMeta {
  return readMeta(parse(raw));
}

/** Inline-script patterns that fail inside the page sandbox / CSP. */
const SANDBOX_TRAPS: Array<{ re: RegExp; warning: string }> = [
  {
    re: /(^|[^.\w])(alert|confirm|prompt)\s*\(/,
    warning: 'script calls alert/confirm/prompt — blocked in the page sandbox',
  },
  {
    // Verified live 2026-10-26: a sandboxed page sends no usable Referer, and
    // these tile servers answer with 403 / "API key required" tiles.
    re: /tile\.openstreetmap\.org|basemaps\.cartocdn\.com|tiles\.stadiamaps\.com/,
    warning:
      'map tiles from OSM/CARTO/Stadia are refused from an opaque-origin page (no Referer; they load on storage pages, verified 2026-11-12) — use Esri: server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}',
  },
  {
    re: /\beval\s*\(|\bnew\s+Function\s*\(/,
    warning: "script uses eval/new Function — blocked (CSP has no 'unsafe-eval')",
  },
];

/**
 * The meta the serving app looks for (its `src/lib/site/serve.ts`, STORAGE_MARKER_RE): present in
 * the head → the page is served with `allow-same-origin` and gets the site origin's storage. Pages
 * that carry it share one origin (one storage bucket, and same-origin access to each other's windows),
 * so it is granted only to pages that need it, never to one that handles an unlock key.
 */
export const STORAGE_MARKER = { name: 'robin:storage', content: 'local' } as const;

const STORAGE_RE = /\b(localStorage|sessionStorage|indexedDB)\b/;
// A sealed page decrypts with a key carried in the URL fragment (#ak=…), and the trip site passes it
// along every internal link. On a shared origin any other storage page holding a window reference
// could read it from location.hash, so a page whose scripts touch such a key stays opaque.
// Errs wide (any `ak=` starting a word): a false hit only costs a page its storage.
const UNLOCK_KEY_RE = /\bak=|crypto\.subtle\.decrypt/;

/**
 * Runs first on every storage page: drops any `ak=` unlock key a link carried into the URL fragment
 * (the trip site appends `#ak=` to its internal links), before other scripts run and before another
 * same-origin window could read it from location.hash.
 */
export const STRIP_KEY_SCRIPT =
  "(function(){var h=location.hash;if(!/[#&]ak=/.test(h))return;var r=h.slice(1).split('&').filter(function(p){return p.slice(0,3)!=='ak='}).join('&');history.replaceState(null,'',location.pathname+location.search+(r?'#'+r:''))})();";

/** Whether the page gets the storage marker, plus the warning to show when it is withheld. */
export function storageDecision(opts: {
  usesStorage: boolean;
  handlesKey: boolean;
  author: string | null;
}): { grant: boolean; warning?: string } {
  const author = opts.author?.trim().toLowerCase() ?? null;
  const wants = author === 'local' || (author !== 'none' && opts.usesStorage);
  if (!wants) return { grant: false };
  if (opts.handlesKey) {
    return {
      grant: false,
      warning:
        'storage stays off: this page handles an #ak= unlock key, so it keeps an opaque origin — localStorage/sessionStorage/indexedDB will throw (wrap in try/catch, or keep state in the URL fragment)',
    };
  }
  return { grant: true };
}

export interface RenderHtmlPageInput {
  raw: string;
  /** Directory local <script src>/<link href> paths resolve against (inlined). */
  sourceDir?: string;
  /** Rewrites an href (internal page link → /pages/<slug>-<hash>); identity if unchanged. */
  rewriteHref: (href: string) => string;
  /** Uploads local <img> sources; omitted (dry run) → local paths are left as-is. */
  uploadLocalImages?: UploadLocalImages;
  /** Uploads local attachment links (<a href="x.xmp">); omitted (dry run) → left as-is. */
  uploadLocalFiles?: UploadLocalImages;
}

// Inlined text ships verbatim on a public page, so only the expected asset
// kind is read — a typo'd or hostile src="notes.md" must not publish a note.
const SCRIPT_EXTS = ['.js', '.mjs'];
const STYLE_EXTS = ['.css'];

async function readLocalAsset(
  path: string,
  sourceDir: string | undefined,
  exts: string[],
): Promise<{ text: string } | { error: string }> {
  if (!sourceDir) return { error: 'no source directory' };
  try {
    const abs = resolveLocalPath(decodeURIComponent(path.replace(/[?#].*$/, '')), sourceDir);
    if (!exts.includes(extname(abs).toLowerCase())) {
      return { error: `not a ${exts.join('/')} file` };
    }
    // resolveLocalPath is lexical; a symlink inside sourceDir can still point out.
    const [real, realDir] = await Promise.all([realpath(abs), realpath(sourceDir)]);
    const rel = relative(realDir, real);
    if (rel.startsWith('..') || isAbsolute(rel)) {
      return { error: 'resolves outside the source directory' };
    }
    const buf = await readFile(real);
    if (buf.length > INLINE_ASSET_MAX_BYTES) {
      return { error: `exceeds ${INLINE_ASSET_MAX_BYTES} bytes` };
    }
    return { text: buf.toString('utf8') };
  } catch (err) {
    const msg =
      (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'not found' : (err as Error).message;
    return { error: msg };
  }
}

export async function renderHtmlPage(input: RenderHtmlPageInput): Promise<RenderedHtmlPage> {
  const warnings: string[] = [];
  const warnOnce = (w: string) => {
    if (!warnings.includes(w)) warnings.push(w);
  };
  const stripped = stripUntrustedBlocks(input.raw);
  if (stripped.removed) warnings.push(`stripped ${stripped.removed} UNTRUSTED block(s)`);
  const tree = parse(stripped.body);
  const meta = readMeta(tree);

  let head: Element | null = null;
  const images: Element[] = [];
  const attachments: Element[] = [];
  const localScripts: Element[] = [];
  const localStyles: Array<{ el: Element; parent: HastNodes }> = [];
  const drop: Array<{ el: Element; parent: HastNodes }> = [];
  const blocked: string[] = [];
  let usesStorage = false;
  let handlesKey = false;
  let storageAuthor: string | null = null;
  const scanScript = (code: string) => {
    for (const t of SANDBOX_TRAPS) if (t.re.test(code)) warnOnce(t.warning);
    if (STORAGE_RE.test(code)) usesStorage = true;
    if (UNLOCK_KEY_RE.test(code)) handlesKey = true;
  };

  walk(tree, (el, parent) => {
    const p = el.properties ?? {};
    switch (el.tagName) {
      case 'head':
        head = el;
        break;
      case 'base':
        drop.push({ el, parent });
        warnOnce('removed <base> (would rewrite every relative URL)');
        break;
      case 'meta': {
        const name = metaName(el);
        // Publisher directives, and any author robots meta: replaced below with
        // a forced noindex.
        if (name === STORAGE_MARKER.name && typeof p.content === 'string')
          storageAuthor = p.content;
        if (name.startsWith('robin:') || name === 'robots') drop.push({ el, parent });
        if (p.httpEquiv != null) {
          drop.push({ el, parent });
          warnOnce(
            'removed <meta http-equiv> (refresh/redirect and CSP overrides are not allowed)',
          );
        }
        break;
      }
      case 'a':
        if (typeof p.href === 'string') {
          const href = input.rewriteHref(p.href);
          p.href = href;
          if (isLocalAttachmentUrl(href)) attachments.push(el);
        }
        break;
      case 'img':
        if (typeof p.src === 'string' && isLocalSrc(p.src)) images.push(el);
        break;
      case 'source':
        // A local srcset is never uploaded; drop it so the browser falls back
        // to the (uploaded) <img>.
        if (typeof p.srcSet === 'string' && isLocalSrc(p.srcSet)) drop.push({ el, parent });
        break;
      case 'script':
        if (typeof p.src === 'string') {
          if (isLocalSrc(p.src)) localScripts.push(el);
          else if (isCrossOrigin(p.src) && !onHosts(p.src, PAGE_SCRIPT_HOSTS)) {
            blocked.push(`script ${p.src}`);
          }
        } else {
          scanScript(textOf(el));
        }
        break;
      case 'link': {
        const rel = ([] as unknown[]).concat(p.rel ?? []).map(String);
        const href = String(p.href ?? '');
        if (!rel.includes('stylesheet')) break;
        if (isLocalSrc(href)) localStyles.push({ el, parent });
        else if (isCrossOrigin(href) && !onHosts(href, PAGE_STYLE_HOSTS)) {
          blocked.push(`stylesheet ${href}`);
        }
        break;
      }
      case 'iframe':
        if (typeof p.src === 'string' && isCrossOrigin(p.src)) blocked.push(`iframe ${p.src}`);
        break;
      case 'form':
        warnOnce("<form> submissions are blocked (CSP form-action 'none') — handle in script");
        break;
      case 'object':
      case 'embed':
        blocked.push(`<${el.tagName}>`);
        break;
    }
  });
  for (const { el, parent } of drop) {
    parent.children = (parent.children ?? []).filter((c) => c !== el);
  }
  if (blocked.length) {
    warnings.push(
      `blocked by the page CSP at serve time (allowed: ${PAGE_SCRIPT_HOSTS.join(', ')}, Google Fonts): ${blocked.join('; ')}`,
    );
  }

  // Local JS/CSS would be served from the blob origin, which the page CSP
  // doesn't allow — inline them instead so multi-file authoring still works.
  for (const el of localScripts) {
    const src = String(el.properties.src);
    const got = await readLocalAsset(src, input.sourceDir, SCRIPT_EXTS);
    if ('error' in got) {
      warnings.push(`local script ${src} not inlined: ${got.error}`);
      continue;
    }
    delete el.properties.src;
    el.children = [{ type: 'text', value: got.text }];
    scanScript(got.text);
  }
  for (const { el, parent } of localStyles) {
    const href = String(el.properties.href);
    const got = await readLocalAsset(href, input.sourceDir, STYLE_EXTS);
    if ('error' in got) {
      warnings.push(`local stylesheet ${href} not inlined: ${got.error}`);
      continue;
    }
    const style: Element = {
      type: 'element',
      tagName: 'style',
      properties: el.properties.media ? { media: el.properties.media } : {},
      children: [{ type: 'text', value: got.text }],
    };
    parent.children = (parent.children ?? []).map((c) => (c === el ? style : c));
  }

  let assetKeys: string[] = [];
  if (images.length && input.uploadLocalImages) {
    const refs = images.map((el) => ({ url: String(el.properties.src) }));
    const up = await input.uploadLocalImages(refs);
    assetKeys = up.assetKeys;
    warnings.push(...up.warnings);
    refs.forEach((ref, i) => {
      images[i].properties.src = ref.url;
      // A local srcset would point at files that were never uploaded.
      delete images[i].properties.srcSet;
    });
  } else if (images.length) {
    warnings.push(`${images.length} local <img> path(s) not uploaded (dry run)`);
  }

  if (attachments.length && input.uploadLocalFiles) {
    const refs = attachments.map((el) => ({ url: String(el.properties.href) }));
    const up = await input.uploadLocalFiles(refs);
    assetKeys = [...assetKeys, ...up.assetKeys];
    warnings.push(...up.warnings);
    refs.forEach((ref, i) => {
      attachments[i].properties.href = ref.url;
    });
  } else if (attachments.length) {
    warnings.push(`${attachments.length} local attachment link(s) not uploaded (dry run)`);
  }

  if (head) {
    const noindex: Element = {
      type: 'element',
      tagName: 'meta',
      properties: { name: 'robots', content: 'noindex' },
      children: [],
    };
    (head as Element).children.unshift(noindex);
  }

  const storage = storageDecision({ usesStorage, handlesKey, author: storageAuthor });
  if (storage.warning) warnings.push(storage.warning);
  if (storage.grant) {
    if (head) {
      const marker: Element = {
        type: 'element',
        tagName: 'meta',
        properties: { name: STORAGE_MARKER.name, content: STORAGE_MARKER.content },
        children: [],
      };
      const strip: Element = {
        type: 'element',
        tagName: 'script',
        properties: {},
        children: [{ type: 'text', value: STRIP_KEY_SCRIPT }],
      };
      // Marker first (the serving app reads it there), then the key strip, before anything else.
      (head as Element).children.unshift(marker, strip);
    } else {
      warnings.push('storage stays off: the page has no <head> to carry the storage marker');
    }
  }

  const stringify = unified().use(rehypeStringify);
  const html = String(
    stringify.stringify(tree as unknown as Parameters<typeof stringify.stringify>[0]),
  );
  return { html, meta, assetKeys, warnings };
}
