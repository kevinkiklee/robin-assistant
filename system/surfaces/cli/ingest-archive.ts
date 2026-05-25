import { basename } from 'node:path';
import { type IngestArchiveResult, ingestArchive } from '../../brain/cognition/ingest-archive.ts';
import { buildDispatcherFromConfig } from '../../brain/llm/build-dispatcher.ts';
import type { LLMDispatcher } from '../../brain/llm/dispatcher.ts';
import { closeDb, openDb } from '../../brain/memory/db.ts';
import { loadModels } from '../../kernel/config/load.ts';
import { dbFilePath, resolveUserDataDir } from '../../lib/paths.ts';

export interface IngestArchiveCliResult extends IngestArchiveResult {
  ts: string;
  dir: string;
  source: string;
}

/**
 * `robin ingest-archive <dir> [--source=name]` — scan `<dir>` for text files and make each
 * recall-searchable as chunked `knowledge.archive` events (idempotent; unchanged chunks skipped).
 *
 * Mirrors `runIngestDocs`: the dispatcher is built best-effort because `ingest()` defers
 * embedding to the embedder job — a missing/misconfigured LLM never blocks indexing.
 */
export function runIngestArchive(dir: string, source?: string): IngestArchiveCliResult {
  const userData = resolveUserDataDir();
  const src = source && source.length > 0 ? source : basename(dir);
  let dispatcher: LLMDispatcher | null = null;
  try {
    dispatcher = buildDispatcherFromConfig(loadModels(userData));
  } catch {
    dispatcher = null;
  }

  const db = openDb(dbFilePath(userData));
  try {
    const r = ingestArchive(db, dispatcher, { dir, source: src });
    return { ts: new Date().toISOString(), dir, source: src, ...r };
  } finally {
    closeDb(db);
  }
}

export function printIngestArchiveHuman(r: IngestArchiveCliResult): void {
  // biome-ignore lint/suspicious/noConsole: CLI output
  console.log(
    `Ingest archive [${r.source}] from ${r.dir}: ${r.files} files → ${r.chunksIngested} new, ${r.chunksUpdated} updated, ${r.chunksSkipped} unchanged chunks (embeddings backfill on next embedder tick)`,
  );
}
