import {
  type IngestContentDocsResult,
  ingestContentDocs,
} from '../../brain/cognition/ingest-docs.ts';
import { buildDispatcherFromConfig } from '../../brain/llm/build-dispatcher.ts';
import type { LLMDispatcher } from '../../brain/llm/dispatcher.ts';
import { closeDb, openDb } from '../../brain/memory/db.ts';
import { loadModels } from '../../kernel/config/load.ts';
import { dbFilePath, resolveUserDataDir } from '../../lib/paths.ts';

export interface IngestDocsCliResult extends IngestContentDocsResult {
  ts: string;
}

/**
 * `robin ingest-docs` — scan content/knowledge/ + content/profile/ for `*.md` and
 * make each searchable via recall (idempotent; unchanged files are skipped).
 *
 * The dispatcher is built best-effort: ingest() defers embedding to the embedder job,
 * so a missing/misconfigured LLM never blocks indexing — it just means the embedder
 * vectorizes the new content rows on its next tick.
 */
export function runIngestDocs(): IngestDocsCliResult {
  const userData = resolveUserDataDir();
  let dispatcher: LLMDispatcher | null = null;
  try {
    dispatcher = buildDispatcherFromConfig(loadModels(userData));
  } catch {
    dispatcher = null;
  }

  const db = openDb(dbFilePath(userData));
  try {
    const r = ingestContentDocs(db, dispatcher, { userDataDir: userData });
    return { ts: new Date().toISOString(), ...r };
  } finally {
    closeDb(db);
  }
}

export function printIngestDocsHuman(r: IngestDocsCliResult): void {
  // biome-ignore lint/suspicious/noConsole: CLI output
  console.log(
    `Ingest docs: ${r.ingested} new, ${r.updated} updated, ${r.skipped} unchanged (embeddings backfill on next embedder tick)`,
  );
}
