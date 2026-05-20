import { buildDispatcherFromConfig } from '../../brain/llm/build-dispatcher.ts';
import type { LLMDispatcher } from '../../brain/llm/dispatcher.ts';
import { closeDb, openDb } from '../../brain/memory/db.ts';
import { embedBody } from '../../brain/memory/embed-content.ts';
import { loadModels } from '../../kernel/config/load.ts';
import { dbFilePath, resolveUserDataDir } from '../../lib/paths.ts';

export interface ReindexOptions {
  limit?: number;
  /** When true, re-embeds rows that already have an embedding. */
  force?: boolean;
  /** Batch size for progress reporting; embed calls remain per-row to bound retry blast radius. */
  batchSize?: number;
  onProgress?: (info: { processed: number; embedded: number; failed: number }) => void;
}

export interface ReindexReport {
  ts: string;
  total_eligible: number;
  embedded: number;
  failed: number;
  errors: string[];
  duration_ms: number;
}

export async function runReindex(opts: ReindexOptions = {}): Promise<ReindexReport> {
  const t0 = Date.now();
  const report: ReindexReport = {
    ts: new Date().toISOString(),
    total_eligible: 0,
    embedded: 0,
    failed: 0,
    errors: [],
    duration_ms: 0,
  };

  const userData = resolveUserDataDir();
  const models = loadModels(userData);
  let dispatcher: LLMDispatcher;
  try {
    dispatcher = buildDispatcherFromConfig(models);
  } catch (err) {
    report.errors.push(`build dispatcher: ${err instanceof Error ? err.message : String(err)}`);
    report.duration_ms = Date.now() - t0;
    return report;
  }

  let provider: ReturnType<LLMDispatcher['getProvider']>;
  try {
    provider = dispatcher.getProvider('embed');
  } catch {
    report.errors.push('no embed role configured in models.yaml — add `roles.embed`');
    report.duration_ms = Date.now() - t0;
    return report;
  }
  if (!provider.embed) {
    report.errors.push(`provider '${provider.name}' does not support embeddings`);
    report.duration_ms = Date.now() - t0;
    return report;
  }

  const db = openDb(dbFilePath(userData));
  try {
    // Eligible = rows in events_content whose embedding is NULL (or any row if --force).
    // We don't filter on events_vec here because the canonical "is embedded" signal is the
    // events_content.embedding BLOB; events_vec is a derived shadow that follows it.
    const eligibleQ = opts.force
      ? db.prepare(`SELECT id, body FROM events_content ORDER BY id`)
      : db.prepare(`SELECT id, body FROM events_content WHERE embedding IS NULL ORDER BY id`);
    const rows = (opts.limit ? eligibleQ.all().slice(0, opts.limit) : eligibleQ.all()) as Array<{
      id: number;
      body: string;
    }>;
    report.total_eligible = rows.length;

    const updateContent = db.prepare(`UPDATE events_content SET embedding = ? WHERE id = ?`);
    // recall.ts JOINs `events_content.id = events_vec.rowid`, so the vec rowid MUST equal
    // the content id. Bare INSERT into vec0 auto-assigns rowids — that only happens to
    // align when ingest writes content + vec lockstep starting from rowid 1. Reindex
    // can't make that assumption, so we set the rowid explicitly (as BigInt; vec0 rejects
    // JS Number for rowid bindings — see ingest.ts for the same workaround).
    const insertVec = db.prepare(`INSERT INTO events_vec(rowid, embedding) VALUES (?, ?)`);
    const deleteVec = db.prepare(`DELETE FROM events_vec WHERE rowid = ?`);
    if (opts.force) db.exec('DELETE FROM events_vec');

    for (const row of rows) {
      try {
        const vec = await embedBody(dispatcher, row.body);
        const buf = Buffer.from(new Float32Array(vec).buffer);
        // One tx per row keeps a single failure from rolling back the whole batch.
        // SQLite handles this cheaply; the embedder is the real time cost, not the writes.
        db.exec('BEGIN');
        try {
          const rowidBig = BigInt(row.id);
          updateContent.run(buf, row.id);
          // Idempotent: an existing vec row at this rowid (from a partial prior run, or
          // because the row had an embedding but got --force'd through) is replaced.
          deleteVec.run(rowidBig);
          insertVec.run(rowidBig, buf);
          db.exec('COMMIT');
        } catch (txErr) {
          db.exec('ROLLBACK');
          throw txErr;
        }
        report.embedded++;
      } catch (err) {
        report.failed++;
        const msg = err instanceof Error ? err.message : String(err);
        // Bound the errors array; one row's failure mode often reflects all rows' failures.
        if (report.errors.length < 5) report.errors.push(`content_id=${row.id}: ${msg}`);
      }
      const processed = report.embedded + report.failed;
      if (opts.batchSize && processed % opts.batchSize === 0) {
        opts.onProgress?.({
          processed,
          embedded: report.embedded,
          failed: report.failed,
        });
      }
    }
  } finally {
    closeDb(db);
  }

  report.duration_ms = Date.now() - t0;
  return report;
}

export function printReindexHuman(report: ReindexReport): void {
  // biome-ignore lint/suspicious/noConsole: CLI output
  console.log(
    `Reindex: ${report.embedded}/${report.total_eligible} embedded, ${report.failed} failed in ${(report.duration_ms / 1000).toFixed(1)}s`,
  );
  if (report.errors.length > 0) {
    // biome-ignore lint/suspicious/noConsole: CLI output
    for (const e of report.errors) console.log(`  ! ${e}`);
  }
}
