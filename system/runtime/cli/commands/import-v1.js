// commands/import-v1.js — `robin import-v1 --src <path> [--dry-run] [--embed=sync|defer]
// [--rollback] [--session <id>] [--include-views]`.
//
// Spec: docs/superpowers/specs/2026-05-11-v1-to-v2-data-migrator-design.md.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readDaemonState } from '../../../config/daemon-state.js';
import { ensureHome, paths } from '../../../config/data-store.js';
import { readConfig } from '../../../config/paths.js';
import { close, connect, defaultDbUrl } from '../../../data/db/client.js';
import { acquire } from '../../../data/db/lock.js';
import { isPidAlive } from '../../daemon/lock.js';
import { rollbackImport, runImport } from '../../install/v1-import/index.js';
import { renderReport } from '../../install/v1-import/report.js';

const USAGE = `usage: robin import-v1 --src <path> [options]

  Imports v1 markdown user-data into v2's SurrealDB.

Options:
  --src <path>          v1 user-data root (or .../user-data/memory). REQUIRED.
  --dry-run             Parse + count without writing.
  --embed=sync|defer    Run embedding backfill at end (default: sync).
  --include-views       Also import LINKS/INDEX/hot/tasks files as memos.
  --rollback            Undo a prior import session.
  --session <id>        For --rollback, target a specific session id.
  --help, -h            Show this message.

The daemon must be stopped: \`robin mcp stop\`.
`;

function parseArgs(argv) {
  const opts = {
    src: null,
    dryRun: false,
    embed: 'sync',
    rollback: false,
    sessionId: null,
    includeViews: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--src') opts.src = argv[++i];
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--include-views') opts.includeViews = true;
    else if (a === '--rollback') opts.rollback = true;
    else if (a === '--session') opts.sessionId = argv[++i];
    else if (a.startsWith('--embed=')) opts.embed = a.slice('--embed='.length);
    else if (a === '--embed') opts.embed = argv[++i];
    else {
      throw new Error(`unknown argument: ${a}`);
    }
  }
  if (opts.embed !== 'sync' && opts.embed !== 'defer') {
    throw new Error(`--embed must be 'sync' or 'defer' (got '${opts.embed}')`);
  }
  return opts;
}

export async function importV1(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    console.error(e.message);
    console.error('');
    console.error(USAGE);
    process.exit(1);
    return;
  }
  if (opts.help) {
    console.log(USAGE);
    return;
  }

  await ensureHome();
  const daemonState = await readDaemonState(paths.data.daemonState());
  if (daemonState && isPidAlive(daemonState.pid)) {
    console.error('daemon is running. Stop it first: robin mcp stop');
    process.exit(1);
  }
  const release = await acquire(paths.data.daemonLock());
  try {
    const db = await connect({ engine: await defaultDbUrl() });
    try {
      if (opts.rollback) {
        const { rolledBack, sessionId, counts, reason } = await rollbackImport({
          db,
          sessionId: opts.sessionId,
        });
        if (!rolledBack) {
          console.error(`rollback: ${reason ?? 'no prior session'}`);
          process.exit(1);
          return;
        }
        console.log(`rolled back session ${sessionId}`);
        for (const [k, v] of Object.entries(counts ?? {})) {
          console.log(`  ${k}: ${v}`);
        }
        return;
      }

      if (!opts.src) {
        console.error('--src is required');
        console.error('');
        console.error(USAGE);
        process.exit(1);
        return;
      }

      if (opts.dryRun) {
        // Run the full read+parse pipeline against an ephemeral mem:// DB so
        // the target is untouched but we get accurate counts.
        const memDb = await connect({ engine: 'mem://' });
        try {
          const { runMigrations } = await import('../../../data/db/migrate.js');
          await runMigrations(memDb, paths.source.migrations());
          const cfg = await readConfig();
          const result = await runImport({
            src: opts.src,
            db: memDb,
            robinHome: paths.data.home(),
            embed: 'defer',
            includeViews: opts.includeViews,
          });
          result.report.embedder_profile = cfg?.embedder_profile ?? 'unknown';
          console.log('=== dry-run (no rows written to target DB) ===');
          console.log(renderReport(result.report));
        } finally {
          await close(memDb);
        }
        return;
      }

      // Real run.
      const cfg = await readConfig();
      const { sessionId, report } = await runImport({
        src: opts.src,
        db,
        robinHome: paths.data.home(),
        embed: opts.embed,
        includeViews: opts.includeViews,
      });
      report.embedder_profile = cfg?.embedder_profile ?? 'unknown';

      console.log(renderReport(report));

      try {
        mkdirSync(paths.data.installReports(), { recursive: true });
        const reportPath = join(paths.data.installReports(), `v1-import-report-${sessionId}.json`);
        writeFileSync(reportPath, JSON.stringify(report, null, 2), { mode: 0o644 });
        console.log('');
        console.log(`report saved: ${reportPath}`);
      } catch (e) {
        console.warn(`(warning) could not persist report json: ${e.message}`);
      }

      if (report.errors.length > 0) process.exit(1);
    } finally {
      await close(db);
    }
  } finally {
    await release();
  }
}
