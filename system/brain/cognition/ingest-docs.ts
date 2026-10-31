import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { htmlToText } from '../../lib/html-text.ts';
import { resolveUserDataDir } from '../../lib/paths.ts';
import type { LLMDispatcher } from '../llm/dispatcher.ts';
import type { RobinDb } from '../memory/db.ts';
import { ingest } from '../memory/ingest.ts';

/** kind written for every doc event; source scopes the external_id namespace. */
const DOC_KIND = 'knowledge.doc';
const DOC_SOURCE = 'docs';

/** Content subdirs scanned for `*.md`, any subfolder included (docs marked sensitive
 *  are still recall-local). */
const SCAN_SUBDIRS = [join('content', 'knowledge'), join('content', 'profile')];

/** Always excluded, whatever the operator configures: voice-profile exemplar banks
 *  are raw personal text (real messages/emails) used for writing AS the operator and
 *  must never auto-ingest into the knowledge graph. */
const BUILTIN_EXCLUDED = ['content/profile/writing/'];

/**
 * Relative path prefixes (POSIX) excluded from ingestion: the built-in list plus the
 * operator's own `exclude:` list in `user-data/config/ingest-docs.yaml` (stale
 * imports, telemetry dumps, archived dev notes). That list lives in user-data
 * because the folder names describe the operator's life; this public code doesn't.
 */
export function excludedPrefixes(root: string): string[] {
  const file = join(root, 'config', 'ingest-docs.yaml');
  if (!existsSync(file)) return BUILTIN_EXCLUDED;
  const raw = (parseYaml(readFileSync(file, 'utf8')) ?? {}) as { exclude?: unknown };
  const extra = Array.isArray(raw.exclude)
    ? raw.exclude.filter((p): p is string => typeof p === 'string' && p.trim() !== '')
    : [];
  return [...BUILTIN_EXCLUDED, ...extra];
}

export interface IngestContentDocsOptions {
  /** Override the user-data root. Defaults to `resolveUserDataDir()`. */
  userDataDir?: string;
}

export interface IngestContentDocsResult {
  /** Files ingested for the first time (no prior event for the external_id). */
  ingested: number;
  /** Files whose body sha matched the stored event — re-embed skipped. */
  skipped: number;
  /** Files whose body changed — event + content updated in place, embedding invalidated. */
  updated: number;
}

/** sha-256 of a doc body; the change-detection key stored in payload.sha. */
function hashBody(body: string): string {
  return createHash('sha256').update(body).digest('hex');
}

/**
 * Recursively collect absolute paths of every `*.md` and `*.html` file under
 * `dir` (published pages are authored as standalone HTML). Missing dir → [].
 */
function collectDocs(dir: string): string[] {
  const out: string[] = [];
  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectDocs(full));
    } else if (entry.isFile() && /\.(md|html)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Scan `content/knowledge/` and `content/profile/` for `*.md` / `*.html` docs and ingest each one
 * so it becomes vector/FTS-searchable via `recall`. Idempotent + update-on-change:
 *
 * - external_id is the file path relative to the user-data root (e.g. `doc:content/profile/character.md`).
 * - If a prior `knowledge.doc` event exists for that external_id with the same body sha, SKIP it
 *   (no re-embed). If the sha differs, re-`ingest()` — which upserts the (source, external_id) row
 *   in place and nulls the embedding so the embedder re-vectorizes it on the next tick.
 *
 * Embedding is deferred to the embedder cognition job (see `ingest()`); huge bodies are
 * truncated only for the embedding vector — the full markdown is always stored.
 */
export function ingestContentDocs(
  db: RobinDb,
  llm: LLMDispatcher | null,
  opts: IngestContentDocsOptions = {},
): IngestContentDocsResult {
  const root = opts.userDataDir ?? resolveUserDataDir();
  const excluded = excludedPrefixes(root);
  const result: IngestContentDocsResult = { ingested: 0, skipped: 0, updated: 0 };

  // Prior body sha for a doc external_id, so we can skip unchanged files without
  // touching ingest(). Mirrors the (source, payload.external_id) identity ingest() upserts on.
  //
  // mtime + size ride along so an untouched file is skipped on a stat alone — no
  // read, no hash (602 docs were read + sha-256'd every 10 minutes). The content
  // sha stays the source of truth: any mtime/size mismatch falls through to the
  // hash, and only a changed sha re-ingests.
  const priorSha = db.prepare(
    `SELECT id,
            json_extract(payload, '$.sha') AS sha,
            json_extract(payload, '$.mtime') AS mtime,
            json_extract(payload, '$.size') AS size
       FROM events
      WHERE source = ? AND json_extract(payload, '$.external_id') = ?
      ORDER BY id DESC LIMIT 1`,
  );
  // Same body, new stat (touched, copied, or a legacy event with no size):
  // refresh the stored stat so the next scan takes the fast path.
  const refreshStat = db.prepare(
    `UPDATE events SET payload = json_set(payload, '$.mtime', ?, '$.size', ?) WHERE id = ?`,
  );

  for (const subdir of SCAN_SUBDIRS) {
    for (const file of collectDocs(join(root, subdir))) {
      // Relative path is the stable identity, normalized to POSIX separators so the
      // external_id is portable across platforms.
      const rel = relative(root, file).split('\\').join('/');
      if (excluded.some((p) => rel.startsWith(p))) {
        result.skipped++;
        continue;
      }
      const externalId = `doc:${rel}`;
      const st = statSync(file);
      const existing = priorSha.get(DOC_SOURCE, externalId) as
        | { id: number; sha: string | null; mtime: number | null; size: number | null }
        | undefined;
      if (
        existing?.sha &&
        existing.mtime != null &&
        // Sub-ms tolerance: SQLite's json_set re-serializes REALs to 15 significant
        // digits, so a refreshed 1791024778572.999 reads back as 1791024778573.
        Math.abs(existing.mtime - st.mtimeMs) < 1 &&
        existing.size === st.size
      ) {
        result.skipped++;
        continue;
      }

      const body = readFileSync(file, 'utf8');
      const sha = hashBody(body);
      if (existing && existing.sha === sha) {
        refreshStat.run(st.mtimeMs, st.size, existing.id);
        result.skipped++;
        continue;
      }

      ingest(db, llm, {
        kind: DOC_KIND,
        source: DOC_SOURCE,
        // HTML is indexed as its visible text; the sha stays over the raw file.
        content: file.endsWith('.html') ? htmlToText(body) : body,
        payload: {
          external_id: externalId,
          path: rel,
          mtime: st.mtimeMs,
          size: st.size,
          sha,
        },
      });

      if (existing) result.updated++;
      else result.ingested++;
    }
  }

  return result;
}

export interface PruneDocEventsResult {
  /** knowledge.doc events removed from the index (event + content + vec rows). */
  pruned: number;
}

/**
 * Remove doc events that no longer belong in the recall index: the path now
 * matches an excluded prefix (exclusion only stops FUTURE ingestion — an event
 * written before a prefix landed would otherwise sit in the index forever) or
 * the file no longer exists on disk under the user-data root.
 *
 * Deleting a doc means three rows: the events row, its events_content row, and
 * its events_vec row. `events_content_fts` is an external-content FTS5 table
 * kept in sync by the events_content_ad trigger (migration 003) — the plain
 * events_content DELETE issues the FTS 'delete' command for us, so lex search
 * stays consistent without a manual FTS write. Events whose payload lacks a
 * path are left alone (nothing to check them against).
 */
export function pruneDocEvents(
  db: RobinDb,
  opts: IngestContentDocsOptions = {},
): PruneDocEventsResult {
  const root = opts.userDataDir ?? resolveUserDataDir();
  const excluded = excludedPrefixes(root);
  const rows = db
    .prepare(
      `SELECT id, content_ref, json_extract(payload, '$.path') AS path
         FROM events WHERE kind = ? AND source = ?`,
    )
    .all(DOC_KIND, DOC_SOURCE) as Array<{
    id: number;
    content_ref: number | null;
    path: string | null;
  }>;

  const stale: Array<{ id: number; contentRef: number | null }> = [];
  for (const row of rows) {
    const path = row.path;
    if (path === null) continue;
    if (excluded.some((p) => path.startsWith(p)) || !existsSync(join(root, path))) {
      stale.push({ id: row.id, contentRef: row.content_ref });
    }
  }
  if (stale.length === 0) return { pruned: 0 };

  const delEvent = db.prepare(`DELETE FROM events WHERE id = ?`);
  const delContent = db.prepare(`DELETE FROM events_content WHERE id = ?`);
  const delVec = db.prepare(`DELETE FROM events_vec WHERE rowid = ?`);
  db.transaction(() => {
    for (const { id, contentRef } of stale) {
      delEvent.run(id);
      if (contentRef !== null) {
        // Fires the events_content_ad trigger → FTS 'delete' (see doc comment).
        delContent.run(contentRef);
        // vec0 rowid bindings reject JS Number (see prune-noise.ts:42) — use BigInt.
        delVec.run(BigInt(contentRef));
      }
    }
  })();

  return { pruned: stale.length };
}
