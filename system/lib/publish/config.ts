export const SLUG_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'; // no i,l,o,0,1
export const SLUG_SUFFIX_LENGTH = 6;
export const SLUG_MAX_LENGTH = 80;
export const COLLISION_RETRY_LIMIT = 5;

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
 * daily-brief job on 2026-05-30 at Kevin's request — this pattern is the
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
