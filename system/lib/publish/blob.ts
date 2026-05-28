import { del, head, put } from '@vercel/blob';
import { BLOB_RETRY_DELAYS_MS, BLOB_RETRY_MAX } from './config.ts';
import type { BlobClient, BlobHeadResult, BlobPutOptions, BlobPutResult } from './types.ts';

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

type SleepFn = (ms: number) => Promise<void>;

// Narrow function shapes for the three @vercel/blob calls we actually make.
// Defined here (rather than as `typeof put` etc.) so tests can mock without
// importing the upstream package's types.
export type PutFn = (
  key: string,
  body: string | Buffer,
  opts: {
    access: 'public';
    token: string;
    contentType?: string;
    addRandomSuffix: false;
    allowOverwrite: boolean;
    cacheControlMaxAge?: number;
  },
) => Promise<{ url: string; pathname?: string }>;
export type HeadFn = (
  key: string,
  opts: { token: string },
) => Promise<{ size: number; url: string; uploadedAt: Date | string }>;
export type DelFn = (key: string, opts: { token: string }) => Promise<void>;

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
  /** Injectable @vercel/blob `put` for tests; defaults to the real upstream call. */
  putFn?: PutFn;
  /** Injectable @vercel/blob `head` for tests. */
  headFn?: HeadFn;
  /** Injectable @vercel/blob `del` for tests. */
  delFn?: DelFn;
}

export function createBlobClient(opts: CreateBlobClientOptions): BlobClient {
  if (!opts.token) throw new Error('createBlobClient: token required');
  const { token, sleepFn } = opts;
  const putFn: PutFn = opts.putFn ?? (put as unknown as PutFn);
  const headFn: HeadFn = opts.headFn ?? (head as unknown as HeadFn);
  const delFn: DelFn = opts.delFn ?? (del as unknown as DelFn);

  const headBlob = async (key: string): Promise<BlobHeadResult> => {
    try {
      const r = await headFn(key, { token });
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
        putFn(key, body, {
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
      await withRetry('DELETE', () => delFn(key, { token }), { sleepFn });
    } catch (rawErr) {
      if (isNotFound(rawErr as ErrLike)) return;
      throw rawErr;
    }
  };

  return { headBlob, putBlob, delBlob };
}
