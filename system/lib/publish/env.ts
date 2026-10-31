// Publish environment + paths, shared by the CLI and library callers.
import { join } from 'node:path';
import type { PublishEnv } from './types.ts';

/**
 * Read the publish env from process.env (callers load secrets/.env first).
 * Returns null when any required value is unset; PUBLISH_PUBLIC_URL defaults
 * to https://askrobin.io.
 */
export function publishEnvFromProcess(): PublishEnv | null {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  const userId = process.env.PUBLISH_USER_ID;
  const blobPublicBaseUrl = process.env.BLOB_PUBLIC_BASE_URL;
  const urlSecret = process.env.PUBLISH_URL_SECRET;
  if (!token || !userId || !blobPublicBaseUrl || !urlSecret) return null;
  return {
    token,
    userId,
    publicUrl: process.env.PUBLISH_PUBLIC_URL || 'https://askrobin.io',
    blobPublicBaseUrl,
    urlSecret,
  };
}

/** Local publish log (source of truth for the manifest). */
export function publishLogPath(userData: string): string {
  return join(userData, 'observability', 'publish', 'index.jsonl');
}
