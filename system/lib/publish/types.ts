export interface PublishEnv {
  token: string;
  userId: string;
  publicUrl: string;
  blobPublicBaseUrl: string;
  /** HMAC key for per-slug URL hashes (PUBLISH_URL_SECRET). */
  urlSecret: string;
}

export interface BlobHeadResult {
  exists: boolean;
  size?: number;
  url?: string;
  uploadedAt?: Date | string;
}

export interface BlobPutOptions {
  contentType?: string;
  cacheControlMaxAge?: number;
  allowOverwrite?: boolean;
  access?: 'public' | 'private';
}

export interface BlobPutResult {
  url: string;
  pathname?: string;
}

export interface ListedBlob {
  pathname: string;
  url: string;
}

export interface BlobClient {
  headBlob: (key: string) => Promise<BlobHeadResult>;
  putBlob: (key: string, body: string | Buffer, opts?: BlobPutOptions) => Promise<BlobPutResult>;
  delBlob: (key: string) => Promise<void>;
  /**
   * List blobs under a key prefix. Optional so test doubles stay small;
   * callers (life_sync's prefs cleanup) no-op without it. The real client
   * from createBlobClient always provides it.
   */
  listBlobs?: (prefix: string) => Promise<ListedBlob[]>;
}

export type PublishMode = 'default' | 'overwrite' | 'as-new' | 'delete';
// 'recategorize' is a metadata-only log row (appended by maintain.ts): it
// changes a live page's category in the manifest without touching the page
// blob, title, description, or updated_at.
export type PublishAction = 'overwrite' | 'append' | 'as-new' | 'delete' | 'noop' | 'recategorize';

export interface PublishOptions {
  source: string | null;
  slug?: string | null;
  mode?: PublishMode;
  forceUntrusted?: boolean;
  /** Publish despite a discretion hit (credential / PII / booking-reference shape). */
  allowSensitive?: boolean;
  dryRun?: boolean;
  env: PublishEnv;
  blobClient: BlobClient;
  logPath: string;
  telemetryPath: string;
  /**
   * Screenshot capture for the thumbnail of photo-less pages. The CLI
   * passes the system-Chrome capture; tests and other callers leave it unset,
   * which also skips thumbnail cleanup on delete.
   */
  thumbCapture?: (url: string) => Promise<Buffer | null>;
}

export interface PublishResult {
  url: string;
  slug: string;
  action: PublishAction;
  blob_key: string;
  asset_count: number;
  warnings: string[];
  dry_run?: boolean;
}

export interface LogRow {
  ts: string;
  action: PublishAction;
  slug: string;
  url: string;
  user_id: string;
  source: string | null;
  blob_key: string;
  title: string | null;
  assets: string[];
  warnings: string[];
  category?: string; // optional: legacy rows predate this
  visibility?: 'public' | 'private'; // legacy field; private pages removed 2026-08-19
  description?: string | null;
}

export interface TelemetryRow {
  ts: string;
  slug: string;
  action: PublishAction;
  source: string | null;
  bytes: number;
  duration_ms: number;
  warning_count: number;
}
