// lab/cli.ts — `pnpm lab doctor | fixture | copy | score`.
//
// Template mode only: nothing here makes a network or paid call, and nothing loads
// the live secrets file.
import { readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { parseArm } from './copy/arm.ts';
import { runCopy } from './copy/run-copy.ts';
import { buildFixture } from './render/fixture.ts';
import { detectLivePaths } from './sandbox/live-paths.ts';
import { scoreCopy } from './score/score-copy.ts';
import { paramsWith } from './script/params.ts';

const REPO_ROOT = resolve(import.meta.dirname, '..');

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail?: string;
}

function check(name: string, fn: () => string | undefined): DoctorCheck {
  try {
    const r = fn();
    return { name, ok: true, ...(r === undefined ? {} : { detail: r }) };
  } catch (err) {
    return { name, ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

export function runDoctor(): { ok: boolean; checks: DoctorCheck[] } {
  const checks: DoctorCheck[] = [
    check('node >= 24', () => {
      const major = Number(process.versions.node.split('.')[0]);
      if (major < 24) throw new Error(`node ${process.versions.node}`);
      return process.versions.node;
    }),
    check('better-sqlite3 opens :memory:', () => {
      const db = new Database(':memory:');
      db.close();
      return undefined;
    }),
    check('sqlite-vec loads', () => {
      const db = new Database(':memory:');
      try {
        sqliteVec.load(db);
        const row = db.prepare('select vec_version() as v').get() as { v: string };
        return row.v;
      } finally {
        db.close();
      }
    }),
    check('cli not under dist/', () => {
      const rel = relative(REPO_ROOT, import.meta.filename).split(/[\\/]/);
      if (rel[0] === 'dist') throw new Error('lab must run from source via tsx, not dist/');
      return undefined;
    }),
    check('live paths detected', () => {
      const n = detectLivePaths(REPO_ROOT).length;
      if (n === 0) throw new Error('no live paths: the path guard would be empty');
      return `${n} guarded`;
    }),
  ];
  return { ok: checks.every((c) => c.ok), checks };
}

const USAGE = `usage: pnpm lab <command>
  doctor
  fixture --seed N --days D [--out DIR]
  copy --fixture DIR --arm FILE.json [--out DIR] [--inline] [--days N]
  score --copy DIR --fixture DIR`;

const print = (line: string) => process.stdout.write(`${line}\n`);
/** Path flags and their defaults resolve against the repo root, never the caller's cwd. */
const repoPath = (p: string): string => resolve(REPO_ROOT, p);

function need(v: string | undefined, flag: string): string {
  if (!v) throw new Error(`missing --${flag}\n${USAGE}`);
  return v;
}

function int(v: string, flag: string): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new Error(`--${flag} must be a non-negative integer`);
  return n;
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case 'doctor': {
      const r = runDoctor();
      print(JSON.stringify(r, null, 2));
      return r.ok ? 0 : 1;
    }
    case 'fixture': {
      const { values } = parseArgs({
        args: rest,
        options: { seed: { type: 'string' }, days: { type: 'string' }, out: { type: 'string' } },
      });
      const seed = int(need(values.seed, 'seed'), 'seed');
      const days = int(need(values.days, 'days'), 'days');
      const out = repoPath(values.out ?? join('lab', 'fixtures', `${seed}-${days}d`));
      const meta = buildFixture(out, paramsWith({ horizonDays: days }), seed);
      print(JSON.stringify({ out, ...meta }, null, 2));
      return 0;
    }
    case 'copy': {
      const { values } = parseArgs({
        args: rest,
        options: {
          fixture: { type: 'string' },
          arm: { type: 'string' },
          out: { type: 'string' },
          inline: { type: 'boolean' },
          days: { type: 'string' },
        },
      });
      const fixtureDir = repoPath(need(values.fixture, 'fixture'));
      const arm = parseArm(JSON.parse(readFileSync(repoPath(need(values.arm, 'arm')), 'utf8')));
      const run = await runCopy({
        fixtureDir,
        arm,
        outDir: repoPath(values.out ?? join('lab', 'runs')),
        mode: values.inline ? 'inline' : 'child',
        ...(values.days !== undefined ? { days: int(values.days, 'days') } : {}),
      });
      // runCopy is strict: a degraded day throws with its problems, and main exits 1.
      for (const r of run.results) {
        print(
          `day ${String(r.day).padStart(3)}  promoted=${r.candidatesPromoted}  unhandled=${r.unhandledPrompts.length}  skipped=${r.disclosureSessionsSkipped.length}  unextracted=${r.disclosureSessionsUnextracted.length}  errors=${r.errors.length}`,
        );
      }
      print(`sandbox: ${run.sandboxRoot}`);
      return 0;
    }
    case 'score': {
      const { values } = parseArgs({
        args: rest,
        options: { copy: { type: 'string' }, fixture: { type: 'string' } },
      });
      const s = scoreCopy(
        repoPath(need(values.copy, 'copy')),
        repoPath(need(values.fixture, 'fixture')),
      );
      const m = s.metrics;
      const f = (v: number | null) => (v === null ? 'n/a' : String(Math.round(v * 1000) / 1000));
      const rows: [string, string][] = [
        ['arm', s.arm],
        ['completedDays / fixture horizon', `${s.completedDays}/${s.fixtureHorizonDays}`],
        ['horizonDay', String(m.horizonDay)],
        ['records (non-retracted, ever)', String(m.records)],
        ['staleness', f(m.staleness)],
        ['stalenessMean', f(m.stalenessMean)],
        ['coverage', f(m.coverage)],
        ['resurrections', String(m.resurrections)],
        ['latency n/events/censored', `${m.latency.n}/${m.latency.events}/${m.latency.censored}`],
        ['latency median (days)', f(m.latency.median)],
        ...Object.entries(m.latency.survivalAt).map(([t, v]): [string, string] => [
          `latency survivalAt[${t}]`,
          f(v),
        ]),
        ['phantomPer100 (current heads)', f(m.phantomPer100)],
        ['phantomRecordsEver', String(m.phantomRecordsEver)],
        ['offCatalogHeads', String(m.offCatalogHeads)],
        ['historicalEverHeld (append-only)', f(m.historicalEverHeld)],
        ['abstentionViolations', String(m.abstentionViolations)],
        ...Object.entries(m.routes).map(([r, v]): [string, string] => [
          `route ${r}`,
          `heads=${v.heads} wrong=${v.wrong}`,
        ]),
      ];
      const w = Math.max(...rows.map(([k]) => k.length));
      for (const [k, v] of rows) print(`${k.padEnd(w)}  ${v}`);
      print(`score.json: ${join(repoPath(values.copy as string), 'score.json')}`);
      return 0;
    }
    default:
      process.stderr.write(`${USAGE}\n`);
      return cmd === undefined || cmd === 'help' ? 0 : 2;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 1;
    },
  );
}
