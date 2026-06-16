import { runBiographer } from '../../brain/cognition/biographer.ts';
import { buildDispatcherFromConfig } from '../../brain/llm/build-dispatcher.ts';
import type { LLMDispatcher } from '../../brain/llm/dispatcher.ts';
import { closeDb, openDb, type RobinDb } from '../../brain/memory/db.ts';
import { allMigrations, applyMigrations } from '../../brain/memory/migrations/index.ts';
import { loadModels } from '../../kernel/config/load.ts';
import { dbFilePath, resolveUserDataDir } from '../../lib/paths.ts';

export interface BiographerCliOptions {
  /** Max unextracted sessions to process this pass. Defaults to 5 (the cron batch size). */
  limit?: number;
  /** When true, run the pass inside a rolled-back transaction so nothing persists. */
  dryRun?: boolean;
}

export interface BiographerCliReport {
  ts: string;
  dryRun: boolean;
  processed: number;
  entitiesCreated: number;
  relationsCreated: number;
  claimsDrafted: number;
  claimsDropped: number;
  errors: string[];
  duration_ms: number;
}

/**
 * `robin biographer [--limit=N] [--dry-run]` — run a bounded biographer pass over
 * up to N unextracted sessions, reusing the exact production extraction path
 * (`runBiographer`). Makes re-extraction spot-checkable without DB surgery.
 *
 * --dry-run wraps the whole pass in `BEGIN … ROLLBACK` (the same trick `robin
 * import --dry-run` uses): the run computes precisely what it WOULD write —
 * entities, relations, drafted claims, the extracted markers and progress cursor
 * — then rolls all of it back, so the report's counts are faithful but the graph
 * is untouched. `runBiographer` runs in autocommit (no nested BEGIN), so the
 * outer transaction is safe.
 */
export async function runBiographerCli(
  opts: BiographerCliOptions = {},
): Promise<BiographerCliReport> {
  const t0 = Date.now();
  const report: BiographerCliReport = {
    ts: new Date().toISOString(),
    dryRun: !!opts.dryRun,
    processed: 0,
    entitiesCreated: 0,
    relationsCreated: 0,
    claimsDrafted: 0,
    claimsDropped: 0,
    errors: [],
    duration_ms: 0,
  };

  const userData = resolveUserDataDir();
  const models = loadModels(userData);
  let dispatcher: LLMDispatcher | null = null;
  try {
    dispatcher = buildDispatcherFromConfig(models);
  } catch (err) {
    // No LLM configured → biographer would finalize sessions with empty extraction,
    // which is destructive. Report and bail rather than march through the backlog.
    report.errors.push(`build dispatcher: ${err instanceof Error ? err.message : String(err)}`);
    report.duration_ms = Date.now() - t0;
    return report;
  }

  const db = openDb(dbFilePath(userData));
  applyMigrations(db, allMigrations);
  try {
    return await runBiographerCliCore(db, dispatcher, opts, t0, report);
  } finally {
    closeDb(db);
  }
}

/**
 * Bounded biographer pass against an already-open db + dispatcher. Caller owns the
 * DB lifecycle. Mirrors `runReindexCore`'s shape so both verbs read alike.
 */
export async function runBiographerCliCore(
  db: RobinDb,
  dispatcher: LLMDispatcher | null,
  opts: BiographerCliOptions = {},
  t0: number = Date.now(),
  report: BiographerCliReport = {
    ts: new Date().toISOString(),
    dryRun: !!opts.dryRun,
    processed: 0,
    entitiesCreated: 0,
    relationsCreated: 0,
    claimsDrafted: 0,
    claimsDropped: 0,
    errors: [],
    duration_ms: 0,
  },
): Promise<BiographerCliReport> {
  const limit = opts.limit ?? 5;
  // Match the production handler's per-chunk behavior so a dry-run reflects what
  // the scheduled job would actually extract.
  const runOpts = { batchChunks: 3, skipToolChunks: true, draftClaims: true } as const;

  if (opts.dryRun) db.exec('BEGIN');
  try {
    const result = await runBiographer(db, dispatcher, limit, runOpts);
    report.processed = result.processed;
    report.entitiesCreated = result.entitiesCreated;
    report.relationsCreated = result.relationsCreated;
    report.claimsDrafted = result.claimsDrafted;
    report.claimsDropped = result.claimsDropped;
    report.errors = result.errors;
    if (opts.dryRun) db.exec('ROLLBACK');
  } catch (err) {
    if (opts.dryRun) db.exec('ROLLBACK');
    report.errors.push(err instanceof Error ? err.message : String(err));
  }

  report.duration_ms = Date.now() - t0;
  return report;
}

export function printBiographerHuman(report: BiographerCliReport): void {
  const prefix = report.dryRun ? 'Biographer (dry-run): would extract' : 'Biographer: extracted';
  console.log(
    `${prefix} ${report.entitiesCreated} entities, ${report.relationsCreated} relations drafted=${report.claimsDrafted} dropped=${report.claimsDropped} from ${report.processed} session(s) in ${(report.duration_ms / 1000).toFixed(1)}s`,
  );
  if (report.errors.length > 0) {
    for (const e of report.errors) {
      console.log(`  ! ${e}`);
    }
  }
}
