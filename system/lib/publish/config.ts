export const SLUG_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'; // no i,l,o,0,1
export const SLUG_SUFFIX_LENGTH = 6;
export const SLUG_MAX_LENGTH = 80;
export const COLLISION_RETRY_LIMIT = 5;

/**
 * Length (hex chars) of the unguessability hash appended to every public page
 * URL: `/@<user>/<slug>-<hash>`. 10 hex chars = 40 bits — enough that URLs
 * can't be enumerated, short enough to stay readable. Derived per-slug via
 * HMAC-SHA256 keyed by PUBLISH_URL_SECRET, so the same slug always republishes
 * to the same URL.
 */
export const URL_HASH_LENGTH = 10;

export const ASSET_CONCURRENCY = 8;
export const ASSET_MAX_BYTES = 10 * 1024 * 1024;
export const ASSETS_PER_PAGE_MAX = 200;
export const ALLOWED_IMAGE_MIMES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/avif',
]);

export const MARKDOWN_SOURCE_MAX_BYTES = 2 * 1024 * 1024;
export const PAGE_PAYLOAD_WARN_BYTES = 25 * 1024 * 1024;
export const PAGE_PAYLOAD_REFUSE_BYTES = 50 * 1024 * 1024;
export const TITLE_MAX_LENGTH = 200;
export const DESCRIPTION_MAX_LENGTH = 300;

export const HTML_CACHE_MAX_AGE = 60;
export const ASSET_CACHE_MAX_AGE = 31_536_000;

export const BLOB_RETRY_MAX = 3;
export const BLOB_RETRY_DELAYS_MS = [200, 800, 3200];

export const RESERVED_SLUG_PREFIX = '_';

/**
 * Slugs the publish pipeline refuses outright (EXIT_POLICY) for any mode≠delete,
 * regardless of caller. The daily brief is a PRIVATE artifact (file + event); it
 * must never reach the public web. Web-publishing was removed from the
 * daily-brief job on 2026-05-30 at the operator's request — this pattern is the
 * defense-in-depth backstop so no future code path (or stray `robin publish`)
 * can re-publish one. Matches `daily-brief` and any `daily-brief-<date>` slug;
 * `delete` is exempt (handled before slug validation) so existing briefs stay
 * removable.
 */
export const REFUSED_SLUG_PATTERN = /^daily-brief(?:-|$)/;

export const EXIT_OK = 0;
export const EXIT_CRASH = 1;
export const EXIT_POLICY = 2;
export const EXIT_INPUT = 3;
export const EXIT_UPSTREAM = 4;

/**
 * Fixed publish taxonomy (display order). Single source of truth — mirrored by
 * the dashboard repo (`CATEGORY_ORDER` in `src/lib/pages/view.ts`,
 * `PAGE_CATEGORIES` in `src/lib/page-ops.ts`); keep in sync.
 */
export const CATEGORIES = [
  'Lens Analysis',
  'Gear & Comparisons',
  'Field Guides',
  'Color Grading',
  'Critiques',
  'Collection Analysis',
  'Essays',
  'Tools & Setup',
  'Projects',
  'Fitness',
] as const;

/** Fallback bucket for pages published without a category; rendered last. */
export const UNCATEGORIZED = 'Uncategorized';

/**
 * Cross-origin hosts a standalone HTML page may load from. MIRRORS the page
 * CSP in askrobin.io `apps/web/lib/publish-serve.ts` (PAGE_SECURITY_HEADERS) —
 * two repos, nothing enforces it; a host missing there is blocked at serve
 * time, and the publisher only warns. Change both together.
 */
export const PAGE_SCRIPT_HOSTS = [
  'https://cdnjs.cloudflare.com',
  'https://cdn.jsdelivr.net',
  'https://unpkg.com',
] as const;
export const PAGE_STYLE_HOSTS = [
  'https://fonts.googleapis.com',
  'https://fonts.gstatic.com',
  ...PAGE_SCRIPT_HOSTS,
] as const;
/** Max bytes of a local .js/.css file inlined into a page at publish time. */
export const INLINE_ASSET_MAX_BYTES = 2 * 1024 * 1024;
