// lab/copy/job.ts
//
// One copy-day as a self-contained job: re-attach to the sandbox, enter it, run the day,
// optionally snapshot the DB. Touches nothing outside sandboxRoot and fixtureDir.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  promptRegistryVersion,
  resetPrompts,
  setPrompts,
} from '../../system/brain/cognition/prompts.ts';
import { closeDb, openDb } from '../../system/brain/memory/db.ts';
import { allMigrations, applyMigrations } from '../../system/brain/memory/migrations/index.ts';
import { resetTuning, tuningHash } from '../../system/brain/memory/tuning.ts';
import { buildLabDispatcher } from '../llm/lab-dispatcher.ts';
import { simPrompts } from '../privacy/sim-prompts.ts';
import { itemsForDay, readFixture } from '../render/fixture.ts';
import { LabIsolationError } from '../sandbox/errors.ts';
import { createSimClock, enterSandbox, reopenSandbox } from '../sandbox/sandbox.ts';
import { type Arm, applyArm } from './arm.ts';
import { type CopyDayResult, dayStartMs, runCopyDay } from './day.ts';
import { openRouteLedger } from './routes.ts';

export interface CopyJob {
  sandboxRoot: string;
  fixtureDir: string;
  day: number;
  arm: Arm;
  livePaths: string[];
  checkpoint: boolean;
}

export interface JobResult extends CopyDayResult {
  tuningHash: string;
  promptVersion: string;
  snapshot: string | null;
}

export async function runJob(job: CopyJob): Promise<JobResult> {
  if (job.livePaths.length === 0) {
    throw new LabIsolationError('no live paths: refusing to run without a path guard');
  }
  const sb = reopenSandbox(job.sandboxRoot);
  const { meta, items } = readFixture(job.fixtureDir);
  const startMs = dayStartMs(meta.startDate, job.day);
  const clock = createSimClock(startMs);
  const exit = enterSandbox(sb, clock, { livePaths: job.livePaths });
  let db: ReturnType<typeof openDb> | null = null;
  try {
    setPrompts(simPrompts());
    const steps = applyArm(job.arm, 'template');
    const { llm, template } = buildLabDispatcher({ mode: 'template' });
    db = openDb(sb.dbPath);
    applyMigrations(db, allMigrations);
    const routes = openRouteLedger(join(sb.root, 'routes.jsonl'));
    const res = await runCopyDay({
      db,
      llm,
      clock,
      sandbox: sb,
      day: job.day,
      dayStartMs: startMs,
      items: itemsForDay(items, job.day),
      steps,
      routes,
      template,
    });
    res.unhandledPrompts = template ? [...template.stats.unhandled] : [];
    let snapshot: string | null = null;
    if (job.checkpoint) {
      const dir = join(sb.root, 'snapshots');
      mkdirSync(dir, { recursive: true });
      snapshot = join(dir, `day-${String(job.day).padStart(4, '0')}.sqlite`);
      if (snapshot.includes("'")) throw new Error(`snapshot path contains a quote: ${snapshot}`);
      db.exec(`VACUUM INTO '${snapshot}'`);
    }
    return { ...res, tuningHash: tuningHash(), promptVersion: promptRegistryVersion(), snapshot };
  } finally {
    if (db) closeDb(db);
    resetTuning();
    resetPrompts();
    exit();
  }
}
