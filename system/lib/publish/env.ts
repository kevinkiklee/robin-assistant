// Publish environment + paths, shared by the CLI and library callers.
import { join } from 'node:path';
import type { PublishEnv } from './types.ts';

/**
 * Read the publish env from process.env (callers load secrets/.env first).
 * Returns null when any required value is unset, including
 * PUBLISH_PUBLIC_URL (the publish host — there is no default).
 */
export function publishEnvFromProcess(): PublishEnv | null {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  const userId = process.env.PUBLISH_USER_ID;
  const blobPublicBaseUrl = process.env.BLOB_PUBLIC_BASE_URL;
  const urlSecret = process.env.PUBLISH_URL_SECRET;
  const publicUrl = normalizePublishHost(process.env.PUBLISH_PUBLIC_URL);
  if (!token || !userId || !blobPublicBaseUrl || !urlSecret || !publicUrl) return null;
  return {
    token,
    userId,
    publicUrl,
    blobPublicBaseUrl,
    urlSecret,
  };
}

/** The publish host with one trailing `/` stripped (so `${host}/pages/…` stays single-slashed). */
export function normalizePublishHost(url: string | undefined): string | undefined {
  return url ? url.replace(/\/$/, '') : undefined;
}

/** Local publish log (source of truth for the manifest). */
export function publishLogPath(userData: string): string {
  return join(userData, 'observability', 'publish', 'index.jsonl');
}
