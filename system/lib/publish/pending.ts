// Web-originated edits arrive as "pending ops"; this module folds them into
// the local publish log.
//
// The publish log (user-data/observability/publish/index.jsonl) is the source
// of truth for the manifest, but it lives on the operator's machine — a delete or a
// recategorize performed from the askrobin.io index page can't append to it.
// Instead the web side writes one immutable blob per action under
// users/<user>/pending/ (`<ms>-<op>-<slug>.json`, never overwritten: the blob
// CDN caches by pathname with no bypass, so a mutable ledger would lose writes
// for ~a minute). This reconciler runs before every manifest rebuild: it
// replays each op as a local log row, then removes the pending blob.
//
// Without this, the next publish's full manifest rebuild — which reads only
// the local log — would silently undo every edit made from the web.
import { CATEGORIES, UNCATEGORIZED } from './config.ts';
import { appendLogEntry, readLog } from './log.ts';
import { toPublicSlug } from './slug.ts';
import type { BlobClient, LogRow, PublishEnv } from './types.ts';

export type PendingOp = 'delete' | 'recategorize';

export interface PendingRecord {
  op: PendingOp;
  slug: string;
  ts: string;
  /** Required for op='recategorize'. */
  category?: string;
  /** Free-form origin marker, e.g. 'index'. */
  by?: string;
}

export interface ReconcileResult {
  /** Ops applied to the local log, as `<op>:<slug>`. */
  applied: string[];
  /** Ops dropped without effect (slug unknown, already deleted, superseded). */
  stale: string[];
  warnings: string[];
}

export function pendingPrefix(userId: string): string {
  return `users/${userId}/pending/`;
}

function isValidPending(v: unknown): v is PendingRecord {
  if (typeof v !== 'object' || v === null) return false;
  const p = v as Record<string, unknown>;
  if (typeof p.slug !== 'string' || p.slug === '') return false;
  if (typeof p.ts !== 'string' || p.ts === '') return false;
  if (p.op === 'delete') return true;
  if (p.op === 'recategorize') {
    return (
      typeof p.category === 'string' &&
      ((CATEGORIES as readonly string[]).includes(p.category) || p.category === UNCATEGORIZED)
    );
  }
  return false;
}

export interface ReconcileOptions {
  env: PublishEnv;
  blobClient: BlobClient;
  logPath: string;
  /** Injectable for tests; pending blob contents are fetched by URL. */
  fetchFn?: typeof fetch;
}

/**
 * Apply pending web-side ops to the local publish log.
 * Never throws — failures land in `warnings` and the blob stays for the next
 * run. Callers rebuild the manifest afterwards.
 */
export async function reconcilePending(opts: ReconcileOptions): Promise<ReconcileResult> {
  const result: ReconcileResult = { applied: [], stale: [], warnings: [] };
  const { blobClient, env, logPath } = opts;
  if (!blobClient.listBlobs) return result; // client without list support (test doubles)
  const fetchFn = opts.fetchFn ?? fetch;

  let listed: { pathname: string; url: string }[];
  try {
    listed = await blobClient.listBlobs(pendingPrefix(env.userId));
  } catch (err) {
    result.warnings.push(`pending list failed: ${(err as Error).message}`);
    return result;
  }
  if (listed.length === 0) return result;

  const { entries } = await readLog(logPath).catch(() => ({ entries: [] as LogRow[] }));
  const latestBySlug = new Map<string, LogRow>();
  for (const e of entries) {
    const cur = latestBySlug.get(e.slug);
    if (!cur || e.ts >= cur.ts) latestBySlug.set(e.slug, e);
  }

  // Oldest first, so two ops on the same slug apply in the order they happened.
  const ordered = [...listed].sort((a, b) => a.pathname.localeCompare(b.pathname));

  for (const blob of ordered) {
    let raw: string;
    try {
      // No cache-bust needed: pending pathnames carry the action timestamp, so
      // each object is written once and never overwritten.
      const res = await fetchFn(blob.url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      raw = await res.text();
    } catch (err) {
      result.warnings.push(`pending fetch failed (${blob.pathname}): ${(err as Error).message}`);
      continue; // leave the blob; retry next run
    }
    let rec: unknown;
    try {
      rec = JSON.parse(raw);
    } catch {
      rec = null; // unparseable content will never become valid — drop below
    }
    if (!isValidPending(rec)) {
      result.warnings.push(`malformed pending op dropped: ${blob.pathname}`);
      await blobClient.delBlob(blob.pathname).catch(() => null);
      continue;
    }

    const latest = latestBySlug.get(rec.slug);
    // Stale when the slug is unknown locally, already deleted, or was
    // republished AFTER the web action (the republish is the newer intent).
    const applicable = latest != null && latest.action !== 'delete' && rec.ts > latest.ts;

    // buildRow also returns null for a recategorize that's already in place.
    const row = applicable && latest ? buildRow(rec, latest, env) : null;
    if (row && latest) {
      if (rec.op === 'delete') {
        // Best-effort asset sweep. The web side deletes the assets it can
        // enumerate; this catches any it missed (deleting a missing key is a
        // no-op).
        for (const assetKey of latest.assets ?? []) {
          await blobClient.delBlob(assetKey).catch(() => null);
        }
      }
      try {
        await appendLogEntry(logPath, row);
        latestBySlug.set(rec.slug, row);
        result.applied.push(`${rec.op}:${rec.slug}`);
      } catch (err) {
        result.warnings.push(`log append failed for ${rec.slug}: ${(err as Error).message}`);
        continue; // keep the blob so the action isn't lost
      }
    } else {
      result.stale.push(`${rec.op}:${rec.slug}`);
    }
    await blobClient.delBlob(blob.pathname).catch(() => null);
  }
  return result;
}

/**
 * Translate a pending op into the log row that expresses it.
 * `delete` writes a fresh minimal row; `recategorize` clones the latest row
 * (keeping title/description/blob_key/assets) with the new category, matching
 * what maintain.ts writes locally.
 */
function buildRow(rec: PendingRecord, latest: LogRow, env: PublishEnv): LogRow | null {
  if (rec.op === 'delete') {
    return {
      ts: rec.ts,
      action: 'delete',
      slug: rec.slug,
      url: `${env.publicUrl}/@${env.userId}/${toPublicSlug(env.userId, rec.slug, env.urlSecret)}`,
      user_id: env.userId,
      source: `web:${rec.by ?? 'index'}`,
      blob_key: latest.blob_key,
      title: null,
      assets: [],
      warnings: [],
    };
  }
  if (rec.op === 'recategorize' && rec.category) {
    if ((latest.category ?? UNCATEGORIZED) === rec.category) return null; // already there
    return {
      ...latest,
      ts: rec.ts,
      action: 'recategorize',
      source: `web:${rec.by ?? 'index'}`,
      category: rec.category,
    };
  }
  return null;
}
