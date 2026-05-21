import { join } from 'node:path';
import { buildDispatcherFromConfig } from '../../brain/llm/build-dispatcher.ts';
import { closeDb, openDb } from '../../brain/memory/db.ts';
import { loadModels } from '../../kernel/config/load.ts';
import { buildJobContext } from '../../jobs/_runtime/context.ts';
import { loadJobs } from '../../jobs/_runtime/loader.ts';
import { dbFilePath, resolveUserDataDir } from '../../lib/paths.ts';

export interface BriefRunResult {
  status: 'ok' | 'error';
  message?: string;
  eventId?: number;
}

/**
 * Run the daily-brief job one-shot, outside the scheduler. Lets the user (or an agent)
 * re-fire the brief on demand when the cron window has passed or a fire failed.
 *
 * Why a CLI verb instead of an MCP tool: the brief spawns `claude -p` in a fresh process
 * which already has full MCP access. Exposing this as `mcp__robin__brief` would mean a
 * Claude-Code session calling another Claude-Code session — a recursion risk and a cost
 * multiplier. CLI invocation keeps the call graph shallow and one-shot.
 */
export async function runBrief(): Promise<BriefRunResult> {
  const userData = resolveUserDataDir();
  const jobsRoot = join(userData, 'extensions/jobs');

  // Build the same LLM dispatcher the daemon would build, lenient so missing secrets
  // don't crash a one-shot run (the brief job's claude spawn doesn't need an embed
  // role, but other code paths along the way might touch the dispatcher).
  const models = loadModels(userData);
  let llm = null;
  try {
    llm = buildDispatcherFromConfig(models, { lenient: true });
  } catch {
    llm = null;
  }

  const db = openDb(dbFilePath(userData));
  try {
    const loaded = await loadJobs([jobsRoot]);
    const briefJob = loaded.find((j) => j.instanceName === 'daily-brief');
    if (!briefJob) {
      return { status: 'error', message: 'daily-brief job not found under user-data/extensions/jobs' };
    }
    const ctx = buildJobContext(briefJob.instanceName, briefJob.rootDir, db, llm);
    const result = await briefJob.module.run(ctx);
    if (result.status === 'ok') {
      return { status: 'ok', eventId: result.eventId };
    }
    return { status: 'error', message: result.message ?? 'job returned non-ok status' };
  } finally {
    closeDb(db);
  }
}

export function printBriefHuman(result: BriefRunResult): void {
  if (result.status === 'ok') {
    // biome-ignore lint/suspicious/noConsole: CLI output
    console.log(`Brief generated. Event id: ${result.eventId}`);
    return;
  }
  // biome-ignore lint/suspicious/noConsole: CLI output
  console.error(`Brief failed: ${result.message ?? 'unknown error'}`);
}
