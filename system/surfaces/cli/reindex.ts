import { buildDispatcherFromConfig } from '../../brain/llm/build-dispatcher.ts';
import type { LLMDispatcher } from '../../brain/llm/dispatcher.ts';
import { closeDb, openDb, type RobinDb } from '../../brain/memory/db.ts';
import { embedBodies, embedBody } from '../../brain/memory/embed-content.ts';
import { loadModels } from '../../kernel/config/load.ts';
import { dbFilePath, resolveUserDataDir } from '../../lib/paths.ts';

export interface ReindexOptions {
  limit?: number;
  /** When true, re-embeds rows that already have an embedding. */
  force?: boolean;
  /** Restrict the reindex to a specific set of events_content.id values. Overrides the
   *  default NULL-embedding filter. Combines with `force` to control whether rows that
   *  already have an embedding are re-embedded; without `force`, the id-set is intersected
   *  with the NULL-embedding rows. */
  ids?: number[];
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

/**
 * Top-level entry: builds the dispatcher from on-disk config, opens the DB, runs
 * the reindex loop. Used by the `robin reindex` CLI verb.
 *
 * For in-process callers that already have a dispatcher and db (e.g. the embedder
 * cognition job), use `runReindexCore` directly to skip the YAML reload + provider rebuild
 * on every invocation.
 */
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

  const db = openDb(dbFilePath(userData));
  try {
    return await runReindexCore(db, dispatcher, opts, t0, report);
  } finally {
    closeDb(db);
  }
}

/**
 * Reindex loop against an already-open db and dispatcher. Caller owns DB lifecycle.
 * Returns the same `ReindexReport` shape regardless of failure mode (errors are
 * accumulated into `report.errors`, never thrown).
 */
export async function runReindexCore(
  db: RobinDb,
  dispatcher: LLMDispatcher,
  opts: ReindexOptions = {},
  t0: number = Date.now(),
  report: ReindexReport = {
    ts: new Date().toISOString(),
    total_eligible: 0,
    embedded: 0,
    failed: 0,
    errors: [],
    duration_ms: 0,
  },
): Promise<ReindexReport> {
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

  {
    // Eligible = rows in events_content whose embedding is NULL (or any row if --force or --ids).
    // We don't filter on events_vec here because the canonical "is embedded" signal is the
    // events_content.embedding BLOB; events_vec is a derived shadow that follows it.
    //
    // `body` is declared TEXT but SQLite stores dynamically — historical ingest writes that
    // bound a Buffer left some rows with BLOB affinity, so better-sqlite3 hands those back as
    // a Node `Buffer`, not a string. The type reflects that; `embedBody`/`prepareForEmbed`
    // normalize the value (UTF-8 decode) before it reaches the embed call.
    type ContentRow = { id: number; body: string | Buffer };
    let rows: ContentRow[];
    if (opts.ids && opts.ids.length > 0) {
      // Parameterized IN-clause; safe since ids are numbers we coerce explicitly.
      const placeholders = opts.ids.map(() => '?').join(',');
      const whereEmbed = opts.force ? '' : ' AND embedding IS NULL';
      rows = db
        .prepare(
          `SELECT id, body FROM events_content WHERE id IN (${placeholders})${whereEmbed} ORDER BY id`,
        )
        .all(...opts.ids.map((n) => Number(n))) as ContentRow[];
    } else {
      const eligibleQ = opts.force
        ? db.prepare(`SELECT id, body FROM events_content ORDER BY id`)
        : db.prepare(`SELECT id, body FROM events_content WHERE embedding IS NULL ORDER BY id`);
      rows = (opts.limit ? eligibleQ.all().slice(0, opts.limit) : eligibleQ.all()) as ContentRow[];
    }
    report.total_eligible = rows.length;

    const updateContent = db.prepare(`UPDATE events_content SET embedding = ? WHERE id = ?`);
    // recall.ts JOINs `events_content.id = events_vec.rowid`, so the vec rowid MUST equal
    // the content id. Bare INSERT into vec0 auto-assigns rowids — that only happens to
    // align when ingest writes content + vec lockstep starting from rowid 1. Reindex
    // can't make that assumption, so we set the rowid explicitly (as BigInt; vec0 rejects
    // JS Number for rowid bindings — see ingest.ts for the same workaround).
    const insertVec = db.prepare(`INSERT INTO events_vec(rowid, embedding) VALUES (?, ?)`);
    const deleteVec = db.prepare(`DELETE FROM events_vec WHERE rowid = ?`);
    // `--force` wipes existing vec rows so they re-emerge with a known-current vector.
    // When `--ids` is also set, only the targeted ids get wiped (full DELETE would erase
    // unrelated rows). The per-row `deleteVec` below handles cleanup either way.
    if (opts.force && !opts.ids) db.exec('DELETE FROM events_vec');

    // Embed in windows of EMBED_BATCH via one batched API call (Gemini
    // batchEmbedContents), then write each row in its own transaction. The batch
    // collapses N network round-trips into one — the dominant cost — while the
    // per-row tx keeps a single bad write from rolling back the whole window. If
    // the batch call fails wholesale (or returns a short/empty result for a row),
    // that row falls back to a single embed so a transient batch error never loses
    // a window.
    const EMBED_BATCH = 64;
    for (let i = 0; i < rows.length; i += EMBED_BATCH) {
      const window = rows.slice(i, i + EMBED_BATCH);
      let vecs: number[][] = [];
      try {
        vecs = await embedBodies(
          dispatcher,
          window.map((r) => r.body),
        );
      } catch {
        vecs = []; // whole-batch failure → per-row fallback below
      }

      for (let j = 0; j < window.length; j++) {
        const row = window[j];
        try {
          let vec = vecs[j];
          if (!vec || vec.length === 0) vec = await embedBody(dispatcher, row.body);
          const buf = Buffer.from(new Float32Array(vec).buffer);
          db.exec('BEGIN');
          try {
            const rowidBig = BigInt(row.id);
            updateContent.run(buf, row.id);
            // Idempotent: an existing vec row at this rowid (partial prior run, or a
            // row that had an embedding but got --force'd through) is replaced.
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
          // Bound the errors array; one row's failure mode often reflects all rows'.
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
    }
  }

  report.duration_ms = Date.now() - t0;
  return report;
}

export function printReindexHuman(report: ReindexReport): void {
  console.log(
    `Reindex: ${report.embedded}/${report.total_eligible} embedded, ${report.failed} failed in ${(report.duration_ms / 1000).toFixed(1)}s`,
  );
  if (report.errors.length > 0) {
    for (const e of report.errors) console.log(`  ! ${e}`);
  }
}
