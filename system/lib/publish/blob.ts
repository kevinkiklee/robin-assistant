import { del, head, put } from '@vercel/blob';
import { BLOB_RETRY_DELAYS_MS, BLOB_RETRY_MAX } from './config.ts';
import type { BlobClient, BlobHeadResult, BlobPutOptions, BlobPutResult } from './types.ts';

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

type SleepFn = (ms: number) => Promise<void>;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface ErrLike {
  status?: number | null;
  message?: string;
  constructor?: { name?: string };
  cause?: ErrLike | null;
}

function isRetryableError(err: ErrLike | null | undefined): boolean {
  if (!err) return false;
  if (err.status == null) return true;
  return RETRYABLE_STATUS.has(err.status);
}

async function withRetry<T>(
  label: string,
  fn: () => Promise<T>,
  opts: { sleepFn?: SleepFn; maxRetries?: number } = {},
): Promise<T> {
  const sleepFn = opts.sleepFn ?? defaultSleep;
  const maxRetries = opts.maxRetries ?? BLOB_RETRY_MAX;
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (rawErr) {
      const err = rawErr as ErrLike;
      if (!isRetryableError(err) || attempt >= maxRetries) {
        const wrapped: Error & { cause?: unknown; status?: number | null } = new Error(
          `upstream ${label} failed: ${err.message ?? rawErr}`,
        );
        wrapped.cause = rawErr;
        wrapped.status = err.status ?? null;
        throw wrapped;
      }
      await sleepFn(BLOB_RETRY_DELAYS_MS[attempt] ?? 3200);
      attempt += 1;
    }
  }
}

function isNotFound(err: ErrLike | null | undefined): boolean {
  if (!err) return false;
  const msg = err.message ?? err.cause?.message ?? '';
  return (
    err.status === 404 ||
    err.cause?.status === 404 ||
    err.constructor?.name === 'BlobNotFoundError' ||
    err.cause?.constructor?.name === 'BlobNotFoundError' ||
    /not found|does not exist/i.test(msg)
  );
}

export interface CreateBlobClientOptions {
  token: string;
  sleepFn?: SleepFn;
}

export function createBlobClient(opts: CreateBlobClientOptions): BlobClient {
  if (!opts.token) throw new Error('createBlobClient: token required');
  const { token, sleepFn } = opts;

  const headBlob = async (key: string): Promise<BlobHeadResult> => {
    try {
      const r = await head(key, { token });
      return { exists: true, size: r.size, url: r.url, uploadedAt: r.uploadedAt };
    } catch (rawErr) {
      const err = rawErr as ErrLike;
      if (isNotFound(err)) return { exists: false };
      throw rawErr;
    }
  };

  const putBlob = async (
    key: string,
    body: string | Buffer,
    putOpts: BlobPutOptions = {},
  ): Promise<BlobPutResult> => {
    return withRetry(
      'PUT',
      () =>
        put(key, body, {
          access: 'public',
          token,
          contentType: putOpts.contentType,
          addRandomSuffix: false,
          allowOverwrite: putOpts.allowOverwrite ?? false,
          ...(putOpts.cacheControlMaxAge != null
            ? { cacheControlMaxAge: putOpts.cacheControlMaxAge }
            : {}),
        }),
      { sleepFn },
    );
  };

  const delBlob = async (key: string): Promise<void> => {
    try {
      await withRetry('DELETE', () => del(key, { token }), { sleepFn });
    } catch (rawErr) {
      if (isNotFound(rawErr as ErrLike)) return;
      throw rawErr;
    }
  };

  return { headBlob, putBlob, delBlob };
}
