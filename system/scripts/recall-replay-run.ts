import { writeFile } from 'node:fs/promises';
import { buildDispatcherFromConfig } from '../brain/llm/build-dispatcher.ts';
import { closeDb, openDb } from '../brain/memory/db.ts';
import { runReplay } from '../brain/memory/recall-replay.ts';
import { loadModels } from '../kernel/config/load.ts';
import { dbFilePath, resolveUserDataDir } from '../lib/paths.ts';
import { loadEnvFile } from '../lib/secrets/load-env.ts';

/**
 * Offline recall-replay run (Wave C):
 *
 *   pnpm exec tsx system/scripts/recall-replay-run.ts --limit 25 --out <path>
 *
 * Samples recent captured prompts, replays them through wide vec recall, judges
 * candidates once per prompt via the classify role, sweeps candidate distance
 * floors, and writes the JSON report to --out (stdout when omitted).
 *
 * Read-only in intent, with one documented side effect: recall() logs each
 * replayed query to recall_log tagged source='manual' — accepted noise, kept
 * separable from the auto-recall hot path by that tag.
 */

function parseArgs(argv: string[]): { limit: number; out: string | undefined } {
  let limit = 25;
  let out: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--limit') {
      limit = Number(argv[++i]);
    } else if (argv[i] === '--out') {
      out = argv[++i];
    }
  }
  if (!Number.isFinite(limit) || limit <= 0) limit = 25;
  return { limit, out };
}

async function main(): Promise<void> {
  const { limit, out } = parseArgs(process.argv.slice(2));
  const userData = resolveUserDataDir();
  loadEnvFile(userData);
  const llm = buildDispatcherFromConfig(loadModels(userData));
  const db = openDb(dbFilePath(userData));
  try {
    const report = await runReplay(db, llm, { promptLimit: limit });
    const json = `${JSON.stringify({ ts: new Date().toISOString(), promptLimit: limit, ...report }, null, 2)}\n`;
    if (out) {
      await writeFile(out, json);
      console.log(
        `replay: ${report.samples} prompts, ${report.judgedPairs} judged pairs, ${report.judgeFailures} judge failures → ${out}`,
      );
    } else {
      process.stdout.write(json);
    }
    if (report.samples > 0 && report.judgeFailures === report.samples) {
      console.error(
        'replay: EVERY judge call failed — the sweep is all-false garbage, not a measurement. Check the classify role assignment in models.yaml.',
      );
      process.exitCode = 1;
    }
  } finally {
    closeDb(db);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    process.exitCode = 1;
  });
}
