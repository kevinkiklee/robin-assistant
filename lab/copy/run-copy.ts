// lab/copy/run-copy.ts
//
// Sequential copy runner: one job per sim-day, a fresh process each in 'child' mode so
// module-level state (tuning, clock, prompts) cannot leak between copies.
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { readFixture } from '../render/fixture.ts';
import { LabIsolationError } from '../sandbox/errors.ts';
import { assertOutsideLive } from '../sandbox/guards.ts';
import { detectLivePaths } from '../sandbox/live-paths.ts';
import { createSandbox } from '../sandbox/sandbox.ts';
import { ARM_NAME, type Arm } from './arm.ts';
import { type CopyJob, type JobResult, runJob } from './job.ts';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');
const WORKER = join(import.meta.dirname, 'worker.ts');

export interface RunCopyOptions {
  fixtureDir: string;
  arm: Arm;
  outDir: string;
  /** Default: the fixture horizon. */
  days?: number;
  /** Default 'child' (spec §6.2: fresh process per copy-day). */
  mode?: 'child' | 'inline';
  /** Default 7; the last day always checkpoints. */
  checkpointEvery?: number;
  /** Default detectLivePaths(repo root) in the REAL env. */
  livePaths?: string[];
  /**
   * Default true: stop the run after any day whose stream degraded — unhandled prompts,
   * skipped or unextracted disclosure sessions, or pipeline errors. That day's result is
   * still appended to results.jsonl first.
   */
  strict?: boolean;
}

export interface CopyRun {
  sandboxRoot: string;
  results: JobResult[];
}

function spawnWorker(jobPath: string, resultPath: string, env: Record<string, string>) {
  return new Promise<void>((resolveP, rejectP) => {
    const child = spawn(process.execPath, ['--import', 'tsx', WORKER, jobPath, resultPath], {
      cwd: REPO_ROOT,
      env,
      stdio: 'inherit',
    });
    child.on('error', rejectP);
    child.on('exit', (code, signal) => {
      if (code === 0) return resolveP();
      let message = signal ? `killed by ${signal}` : `exit code ${code}`;
      if (existsSync(resultPath)) {
        try {
          const r = JSON.parse(readFileSync(resultPath, 'utf8')) as { error?: string };
          if (r.error) message = r.error;
        } catch {}
      }
      rejectP(new Error(message));
    });
  });
}

const MAX_LISTED = 3;
const list = (xs: string[]) =>
  xs.slice(0, MAX_LISTED).join(' | ') +
  (xs.length > MAX_LISTED ? ` | +${xs.length - MAX_LISTED} more` : '');

/** A one-line summary of what degraded on a copy-day, or null when the stream is intact. */
export function streamProblems(res: JobResult): string | null {
  const parts: string[] = [];
  const add = (name: string, xs: string[]) => {
    if (xs.length > 0) parts.push(`${name}(${xs.length}): ${list(xs)}`);
  };
  add('unhandledPrompts', res.unhandledPrompts);
  add('disclosureSessionsSkipped', res.disclosureSessionsSkipped);
  add('disclosureSessionsUnextracted', res.disclosureSessionsUnextracted);
  add('errors', res.errors);
  return parts.length > 0 ? parts.join('; ') : null;
}

export async function runCopy(opts: RunCopyOptions): Promise<CopyRun> {
  // Real env, before anything is created.
  const livePaths = opts.livePaths ?? detectLivePaths(REPO_ROOT);
  if (livePaths.length === 0) {
    throw new LabIsolationError('no live paths: refusing to run without a path guard');
  }
  // The run root, run.json, jobs/, routes.jsonl, sim docs and snapshots are written with
  // plain fs/SQLite, outside the db path guard: refuse a live location before any write.
  if (!ARM_NAME.test(opts.arm.name)) {
    throw new LabIsolationError(`invalid arm name: ${opts.arm.name} (want ${ARM_NAME})`);
  }
  assertOutsideLive(opts.outDir, livePaths, 'copy output dir');
  assertOutsideLive(opts.fixtureDir, livePaths, 'fixture dir');
  const { meta } = readFixture(opts.fixtureDir);
  const days = opts.days ?? meta.horizonDays;
  const every = opts.checkpointEvery ?? 7;
  const mode = opts.mode ?? 'child';
  const strict = opts.strict ?? true;
  const sb = createSandbox({ root: join(opts.outDir, opts.arm.name) });
  writeFileSync(
    join(sb.root, 'run.json'),
    `${JSON.stringify({ arm: opts.arm, fixture: meta, startedAt: new Date().toISOString() }, null, 2)}\n`,
  );
  const jobsDir = join(sb.root, 'jobs');
  mkdirSync(jobsDir, { recursive: true });
  const resultsPath = join(sb.root, 'results.jsonl');
  const results: JobResult[] = [];

  for (let day = 0; day < days; day++) {
    const job: CopyJob = {
      sandboxRoot: sb.root,
      fixtureDir: opts.fixtureDir,
      day,
      arm: opts.arm,
      livePaths,
      checkpoint: (day + 1) % every === 0 || day === days - 1,
    };
    const tag = String(day).padStart(4, '0');
    const jobPath = join(jobsDir, `day-${tag}.job.json`);
    const resultPath = join(jobsDir, `day-${tag}.result.json`);
    writeFileSync(jobPath, JSON.stringify(job));
    let res: JobResult;
    try {
      if (mode === 'child') {
        await spawnWorker(jobPath, resultPath, sb.env);
        res = JSON.parse(readFileSync(resultPath, 'utf8')) as JobResult;
      } else {
        res = await runJob(job);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`copy ${opts.arm.name} failed on day ${day}: ${message}`);
    }
    appendFileSync(resultsPath, `${JSON.stringify(res)}\n`);
    results.push(res);
    const problems = streamProblems(res);
    if (strict && problems) {
      throw new Error(`copy ${opts.arm.name} stream integrity failed on day ${day}: ${problems}`);
    }
  }
  return { sandboxRoot: sb.root, results };
}
