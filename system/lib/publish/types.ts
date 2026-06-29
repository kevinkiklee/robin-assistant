export interface PublishEnv {
  token: string;
  userId: string;
  publicUrl: string;
  blobPublicBaseUrl: string;
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

export interface BlobClient {
  headBlob: (key: string) => Promise<BlobHeadResult>;
  putBlob: (key: string, body: string | Buffer, opts?: BlobPutOptions) => Promise<BlobPutResult>;
  delBlob: (key: string) => Promise<void>;
}

export type PublishMode = 'default' | 'overwrite' | 'as-new' | 'delete';
export type PublishAction = 'overwrite' | 'append' | 'as-new' | 'delete' | 'noop';

export interface PublishOptions {
  source: string | null;
  slug?: string | null;
  mode?: PublishMode;
  forceUntrusted?: boolean;
  dryRun?: boolean;
  env: PublishEnv;
  blobClient: BlobClient;
  logPath: string;
  telemetryPath: string;
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
