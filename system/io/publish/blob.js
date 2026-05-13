import { head, put, del } from '@vercel/blob';
import { BLOB_RETRY_MAX, BLOB_RETRY_DELAYS_MS } from './config.js';

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

function defaultSleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function isRetryableError(err) {
  // SDK errors expose a `.status` property; transient when in RETRYABLE_STATUS.
  // Network errors (no status) are also retryable.
  if (!err) return false;
  if (err.status == null) return true;
  return RETRYABLE_STATUS.has(err.status);
}

async function withRetry(label, fn, { sleepFn = defaultSleep, maxRetries = BLOB_RETRY_MAX } = {}) {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (err) {
      if (!isRetryableError(err) || attempt >= maxRetries) {
        const wrapped = new Error(`upstream ${label} failed: ${err.message ?? err}`);
        wrapped.cause = err;
        wrapped.status = err.status;
        throw wrapped;
      }
      await sleepFn(BLOB_RETRY_DELAYS_MS[attempt] ?? 3200);
      attempt += 1;
    }
  }
}

export function createBlobClient({ token, sdk = { head, put, del }, sleepFn = defaultSleep }) {
  if (!token) throw new Error('createBlobClient: token required');

  async function headBlob(key) {
    try {
      const r = await sdk.head(key, { token });
      return { exists: true, size: r.size, url: r.url, uploadedAt: r.uploadedAt };
    } catch (err) {
      // @vercel/blob throws BlobNotFoundError with message "The requested blob does not exist".
      // Treat any not-found-flavored error as a missing blob; rethrow others.
      const msg = err?.message ?? '';
      if (
        err?.status === 404
        || err?.constructor?.name === 'BlobNotFoundError'
        || /not found/i.test(msg)
        || /does not exist/i.test(msg)
      ) {
        return { exists: false };
      }
      throw err;
    }
  }

  async function putBlob(key, body, { contentType, cacheControlMaxAge, allowOverwrite = false } = {}) {
    return withRetry('PUT', () =>
      sdk.put(key, body, {
        access: 'public',
        token,
        contentType,
        addRandomSuffix: false,
        allowOverwrite,
        ...(cacheControlMaxAge != null ? { cacheControlMaxAge } : {}),
      }),
      { sleepFn },
    );
  }

  async function delBlob(key) {
    try {
      await withRetry('DELETE', () => sdk.del(key, { token }), { sleepFn });
    } catch (err) {
      // del is idempotent — treat any not-found-flavored error as success
      const msg = err?.message ?? err?.cause?.message ?? '';
      if (
        err?.status === 404
        || err?.cause?.status === 404
        || err?.constructor?.name === 'BlobNotFoundError'
        || err?.cause?.constructor?.name === 'BlobNotFoundError'
        || /not found|does not exist/i.test(msg)
      ) {
        return;
      }
      throw err;
    }
  }

  return { headBlob, putBlob, delBlob };
}
