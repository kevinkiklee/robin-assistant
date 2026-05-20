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

export const EXIT_OK = 0;
export const EXIT_CRASH = 1;
export const EXIT_POLICY = 2;
export const EXIT_INPUT = 3;
export const EXIT_UPSTREAM = 4;
