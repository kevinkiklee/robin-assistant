import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { LLMDispatcher } from '../llm/dispatcher.ts';
import type { RobinDb } from '../memory/db.ts';
import { ingest } from '../memory/ingest.ts';

/** Event kind written for every archive chunk. Distinct from `knowledge.doc` (curated docs)
 *  so bulk-imported, lower-curation content is filterable in recall and never mistaken for
 *  the hand-authored spine. Like all ingested content it becomes recall-searchable; it does
 *  NOT feed the biographer graph (which extracts only from `session.captured`). */
const ARCHIVE_KIND = 'knowledge.archive';

/** Text-like extensions worth indexing. Binary/media files are skipped. */
const TEXT_EXTS = ['.md', '.mdx', '.txt', '.text', '.json', '.csv', '.html', '.htm'];

export interface IngestArchiveOptions {
  /** Directory scanned recursively for text files. */
  dir: string;
  /** Event `source` namespace, e.g. `blog-iser`, `takeout-gmail`. Also scopes external_id. */
  source: string;
  /** Max characters per chunk. Default 4000. */
  maxChars?: number;
  /** Extensions to include (lowercased, with leading dot). Defaults to TEXT_EXTS. */
  exts?: string[];
}

export interface IngestArchiveResult {
  /** Files read (after extension/processed filtering). */
  files: number;
  /** Chunks ingested for the first time. */
  chunksIngested: number;
  /** Chunks whose sha matched a prior event — re-ingest skipped. */
  chunksSkipped: number;
  /** Chunks whose body changed — upserted in place. */
  chunksUpdated: number;
}

/**
 * Split `text` into chunks no larger than `maxChars`, breaking on blank-line (paragraph)
 * boundaries where possible. Small inputs return a single chunk. A single paragraph that
 * exceeds `maxChars` is hard-split. Chunking keeps recall granular: each chunk is embedded
 * separately rather than a whole 200 KB export collapsing to one vector.
 */
export function chunkText(text: string, maxChars = 4000): string[] {
  if (text.length <= maxChars) return [text];
  const chunks: string[] = [];
  let cur = '';
  const flush = () => {
    if (cur) {
      chunks.push(cur);
      cur = '';
    }
  };
  for (const para of text.split(/\n{2,}/)) {
    if (para.length > maxChars) {
      flush();
      for (let i = 0; i < para.length; i += maxChars) chunks.push(para.slice(i, i + maxChars));
      continue;
    }
    if (cur && cur.length + para.length + 2 > maxChars) flush();
    cur = cur ? `${cur}\n\n${para}` : para;
  }
  flush();
  return chunks;
}

/** Recursively collect text-file paths under `dir`, skipping any `processed/` segment and
 *  non-text extensions. Missing dir → []. */
function collectFiles(dir: string, exts: string[]): string[] {
  const out: string[] = [];
  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name === 'processed') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectFiles(full, exts));
    } else if (entry.isFile() && exts.some((x) => entry.name.toLowerCase().endsWith(x))) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Scan `opts.dir` for text files and ingest each (chunked) as a `knowledge.archive` event,
 * making the content recall-searchable. Idempotent + update-on-change via the same
 * (source, payload.external_id) sha idiom as `ingest-docs`:
 *
 * - external_id = `archive:<source>:<relpath>#<chunkIndex>` (POSIX-normalized rel path).
 * - Unchanged chunk (matching sha) → skipped. Changed → `ingest()` upserts in place.
 *
 * Embedding is deferred to the embedder job (see `ingest()`), so `llm` may be null.
 */
export function ingestArchive(
  db: RobinDb,
  llm: LLMDispatcher | null,
  opts: IngestArchiveOptions,
): IngestArchiveResult {
  const maxChars = opts.maxChars ?? 4000;
  const exts = opts.exts ?? TEXT_EXTS;
  const result: IngestArchiveResult = {
    files: 0,
    chunksIngested: 0,
    chunksSkipped: 0,
    chunksUpdated: 0,
  };

  const priorSha = db.prepare(
    `SELECT json_extract(payload, '$.sha') AS sha FROM events
      WHERE source = ? AND json_extract(payload, '$.external_id') = ?
      ORDER BY id DESC LIMIT 1`,
  );

  for (const file of collectFiles(opts.dir, exts)) {
    const rel = relative(opts.dir, file).split('\\').join('/');
    const body = readFileSync(file, 'utf8');
    result.files++;
    const chunks = chunkText(body, maxChars);
    chunks.forEach((chunk, i) => {
      const externalId = `archive:${opts.source}:${rel}#${i}`;
      const sha = createHash('sha256').update(chunk).digest('hex');
      const existing = priorSha.get(opts.source, externalId) as { sha: string | null } | undefined;
      if (existing && existing.sha === sha) {
        result.chunksSkipped++;
        return;
      }
      ingest(db, llm, {
        kind: ARCHIVE_KIND,
        source: opts.source,
        content: chunk,
        payload: { external_id: externalId, path: rel, chunk: i, chunks: chunks.length, sha },
      });
      if (existing) result.chunksUpdated++;
      else result.chunksIngested++;
    });
  }

  return result;
}
