import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { resolveUserDataDir } from '../../lib/paths.ts';
import type { LLMDispatcher } from '../llm/dispatcher.ts';
import type { RobinDb } from '../memory/db.ts';
import { ingest } from '../memory/ingest.ts';

/** kind written for every doc event; source scopes the external_id namespace. */
const DOC_KIND = 'knowledge.doc';
const DOC_SOURCE = 'docs';

/** Content subdirs scanned for `*.md`. medical/ and finance/ live under knowledge/ and
 *  are intentionally included — recall is local, the user migrated them on purpose. */
const SCAN_SUBDIRS = [join('content', 'knowledge'), join('content', 'profile')];

/** Relative path prefixes (POSIX) excluded from ingestion. These are stale V1
 *  engineering artifacts, Robin operational docs, or archived dev-internal files
 *  that pollute the knowledge graph without adding personal/biographical value. */
const EXCLUDED_PREFIXES = [
  'content/knowledge/imported-from-v1/self-improvement/',
  'content/knowledge/imported-from-v1/streams/',
  'content/knowledge/imported-from-v1/watches/',
  'content/knowledge/imported-from-v1/tasks.md',
  'content/knowledge/imported-from-v1/ENTITIES.md',
  'content/knowledge/imported-from-v1/LINKS.md',
  'content/knowledge/imported-from-v1/MANIFEST.md',
  'content/knowledge/imported-from-v1/INDEX.md',
  'content/knowledge/imported-from-v1/hot.md',
  'content/knowledge/imported-from-v1/_PROVENANCE.md',
  'content/knowledge/archive/resolved-bugs/',
  'content/knowledge/archive/sessions/',
  'content/knowledge/robin-operations/cross-link-proactively.md',
  'content/knowledge/robin-operations/daily-brief-protocol.md',
];

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

/** Recursively collect absolute paths of every `*.md` file under `dir`. Missing dir → []. */
function collectMarkdown(dir: string): string[] {
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
      out.push(...collectMarkdown(full));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Scan `content/knowledge/` and `content/profile/` for `*.md` docs and ingest each one
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
  const result: IngestContentDocsResult = { ingested: 0, skipped: 0, updated: 0 };

  // Prior body sha for a doc external_id, so we can skip unchanged files without
  // touching ingest(). Mirrors the (source, payload.external_id) identity ingest() upserts on.
  const priorSha = db.prepare(
    `SELECT json_extract(payload, '$.sha') AS sha FROM events
      WHERE source = ? AND json_extract(payload, '$.external_id') = ?
      ORDER BY id DESC LIMIT 1`,
  );

  for (const subdir of SCAN_SUBDIRS) {
    for (const file of collectMarkdown(join(root, subdir))) {
      // Relative path is the stable identity, normalized to POSIX separators so the
      // external_id is portable across platforms.
      const rel = relative(root, file).split('\\').join('/');
      if (EXCLUDED_PREFIXES.some((p) => rel.startsWith(p))) {
        result.skipped++;
        continue;
      }
      const externalId = `doc:${rel}`;
      const body = readFileSync(file, 'utf8');
      const sha = hashBody(body);

      const existing = priorSha.get(DOC_SOURCE, externalId) as { sha: string | null } | undefined;
      if (existing && existing.sha === sha) {
        result.skipped++;
        continue;
      }

      ingest(db, llm, {
        kind: DOC_KIND,
        source: DOC_SOURCE,
        content: body,
        payload: {
          external_id: externalId,
          path: rel,
          mtime: statSync(file).mtimeMs,
          sha,
        },
      });

      if (existing) result.updated++;
      else result.ingested++;
    }
  }

  return result;
}
