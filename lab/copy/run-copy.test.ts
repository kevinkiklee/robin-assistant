import assert from 'node:assert/strict';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { buildFixture } from '../render/fixture.ts';
import { LabIsolationError } from '../sandbox/errors.ts';
import { detectLivePaths } from '../sandbox/live-paths.ts';
import { paramsWith } from '../script/params.ts';
import { runCopy, streamProblems } from './run-copy.ts';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');

test('runCopy: inline 8-day run promotes, checkpoints weekly and on the last day', {
  timeout: 120_000,
}, async () => {
  const fx = mkdtempSync(join(tmpdir(), 'lab-fx-'));
  buildFixture(fx, paramsWith({ horizonDays: 8 }), 51);
  const out = mkdtempSync(join(tmpdir(), 'lab-run-'));
  const run = await runCopy({
    fixtureDir: fx,
    arm: { name: 'baseline' },
    outDir: out,
    mode: 'inline',
    livePaths: ['/nonexistent-live'],
  });
  assert.equal(run.results.length, 8);
  assert.ok(existsSync(join(run.sandboxRoot, 'snapshots', 'day-0006.sqlite')));
  assert.ok(existsSync(join(run.sandboxRoot, 'snapshots', 'day-0007.sqlite')));
  assert.ok(run.results.some((r) => r.candidatesPromoted > 0));
  assert.ok(run.results.every((r) => r.tuningHash === run.results[0].tuningHash));
  // A head capture per day, holding at least the rows promoted so far.
  const caps = readdirSync(join(run.sandboxRoot, 'heads')).sort();
  assert.deepEqual(
    caps,
    [0, 1, 2, 3, 4, 5, 6, 7].map((d) => `day-000${d}.jsonl`),
  );
  const last = readFileSync(join(run.sandboxRoot, 'heads', 'day-0007.jsonl'), 'utf8');
  assert.ok(last.split('\n').some((l) => l.includes('"sources":true')));
});

test('runCopy: child mode runs each day in a fresh process', { timeout: 120_000 }, async () => {
  const fx = mkdtempSync(join(tmpdir(), 'lab-fx-'));
  buildFixture(fx, paramsWith({ horizonDays: 2 }), 52);
  const out = mkdtempSync(join(tmpdir(), 'lab-run-'));
  const run = await runCopy({
    fixtureDir: fx,
    arm: { name: 'baseline' },
    outDir: out,
    mode: 'child',
    livePaths: ['/nonexistent-live'],
  });
  assert.equal(run.results.length, 2);
});

test('runCopy: refuses an empty live-path list', async () => {
  await assert.rejects(
    runCopy({ fixtureDir: '/x', arm: { name: 'a' }, outDir: '/y', livePaths: [] }),
    /no live paths/,
  );
});

test('runCopy: a day that throws stops the run and names the day', {
  timeout: 120_000,
}, async () => {
  const fx = mkdtempSync(join(tmpdir(), 'lab-fx-'));
  buildFixture(fx, paramsWith({ horizonDays: 4 }), 53);
  // Corrupt day 2: an unknown item type makes runCopyDay throw.
  appendFileSync(
    join(fx, 'stream.jsonl'),
    `${JSON.stringify({ type: 'bogus', id: 'x', day: 2, minute: 1 })}\n`,
  );
  const out = mkdtempSync(join(tmpdir(), 'lab-run-'));
  await assert.rejects(
    runCopy({
      fixtureDir: fx,
      arm: { name: 'baseline' },
      outDir: out,
      mode: 'inline',
      livePaths: ['/nonexistent-live'],
    }),
    /failed on day 2/,
  );
  const lines = readFileSync(join(out, 'baseline', 'results.jsonl'), 'utf8')
    .trim()
    .split('\n');
  assert.equal(lines.length, 2); // days 0 and 1 only
});

test('runCopy: the real-env live-path detection is non-empty on this machine', () => {
  assert.ok(detectLivePaths(REPO_ROOT).length > 0);
});

test('runCopy: refuses an output dir under a live path, before writing anything', async () => {
  const fx = mkdtempSync(join(tmpdir(), 'lab-fx-'));
  buildFixture(fx, paramsWith({ horizonDays: 2 }), 54);
  const live = mkdtempSync(join(tmpdir(), 'lab-live-'));
  const opts = { fixtureDir: fx, arm: { name: 'baseline' }, mode: 'inline' as const };
  await assert.rejects(
    runCopy({ ...opts, outDir: join(live, 'runs'), livePaths: [live] }),
    (e: unknown) => e instanceof LabIsolationError && /copy output dir/.test(e.message),
  );
  // Through a symlink, and via `..` segments.
  const link = join(mkdtempSync(join(tmpdir(), 'lab-link-')), 'out');
  symlinkSync(live, link);
  await assert.rejects(
    runCopy({ ...opts, outDir: join(link, 'runs'), livePaths: [live] }),
    LabIsolationError,
  );
  await assert.rejects(
    runCopy({
      ...opts,
      outDir: join(fx, '..', live.split('/').at(-1) as string),
      livePaths: [live],
    }),
    LabIsolationError,
  );
  assert.deepEqual(readdirSync(live), []);
});

test('runCopy: refuses a fixture dir under a live path', async () => {
  const live = mkdtempSync(join(tmpdir(), 'lab-live-'));
  const fx = join(live, 'fx');
  mkdirSync(fx);
  buildFixture(fx, paramsWith({ horizonDays: 2 }), 55);
  await assert.rejects(
    runCopy({
      fixtureDir: fx,
      arm: { name: 'baseline' },
      outDir: mkdtempSync(join(tmpdir(), 'lab-run-')),
      mode: 'inline',
      livePaths: [live],
    }),
    (e: unknown) => e instanceof LabIsolationError && /fixture dir/.test(e.message),
  );
});

test('runCopy: refuses an arm name that is not [a-z0-9-]', async () => {
  const out = mkdtempSync(join(tmpdir(), 'lab-run-'));
  for (const name of ['../escape', 'a/b', 'Upper', '']) {
    await assert.rejects(
      runCopy({
        fixtureDir: '/nonexistent-fixture',
        arm: { name },
        outDir: out,
        livePaths: ['/nonexistent-live'],
      }),
      (e: unknown) => e instanceof LabIsolationError && /invalid arm name/.test(e.message),
      name,
    );
  }
  assert.deepEqual(readdirSync(out), []);
});

/** A 4-day fixture whose day 1 carries a disclosure session too short to capture. */
function degradedFixture(seed: number): string {
  const fx = mkdtempSync(join(tmpdir(), 'lab-fx-'));
  buildFixture(fx, paramsWith({ horizonDays: 4 }), seed);
  appendFileSync(
    join(fx, 'stream.jsonl'),
    `${JSON.stringify({
      type: 'session',
      id: 'session:short',
      day: 1,
      minute: 100,
      sessionId: 'short-1',
      filler: false,
      turns: [{ role: 'user', content: 'Too short to capture.' }],
    })}\n`,
  );
  return fx;
}

test('runCopy: strict (default) stops after a degraded day, keeping its result', {
  timeout: 120_000,
}, async () => {
  const fx = degradedFixture(56);
  const out = mkdtempSync(join(tmpdir(), 'lab-run-'));
  await assert.rejects(
    runCopy({
      fixtureDir: fx,
      arm: { name: 'baseline' },
      outDir: out,
      mode: 'inline',
      livePaths: ['/nonexistent-live'],
    }),
    /copy baseline stream integrity failed on day 1: disclosureSessionsSkipped\(1\): short-1/,
  );
  const lines = readFileSync(join(out, 'baseline', 'results.jsonl'), 'utf8')
    .trim()
    .split('\n');
  assert.equal(lines.length, 2); // days 0 and 1: the failing day is recorded
});

test('runCopy: strict:false runs every day and reports the degraded one', {
  timeout: 120_000,
}, async () => {
  const fx = degradedFixture(56);
  const run = await runCopy({
    fixtureDir: fx,
    arm: { name: 'baseline' },
    outDir: mkdtempSync(join(tmpdir(), 'lab-run-')),
    mode: 'inline',
    livePaths: ['/nonexistent-live'],
    strict: false,
  });
  assert.equal(run.results.length, 4);
  assert.deepEqual(run.results[1].disclosureSessionsSkipped, ['short-1']);
  assert.match(streamProblems(run.results[1]) ?? '', /disclosureSessionsSkipped/);
  assert.equal(streamProblems(run.results[0]), null);
});

test('streamProblems: lists errors and unhandled prompts, capped', () => {
  const base = {
    day: 0,
    sessionsCaptured: 0,
    sessionsSkipped: {},
    disclosureSessionsSkipped: [],
    disclosureSessionsUnextracted: [],
    docsWritten: 0,
    assistantCalls: 0,
    biographerProcessed: 0,
    candidatesPromoted: 0,
    candidatesExpired: 0,
    errors: ['e1', 'e2', 'e3', 'e4'],
    unhandledPrompts: ['p1'],
    tuningHash: '',
    promptVersion: '',
    snapshot: null,
  };
  assert.equal(streamProblems(base), 'unhandledPrompts(1): p1; errors(4): e1 | e2 | e3 | +1 more');
});
