// lab/score/score-copy.ts
//
// Score one finished copy run: state metrics from the newest snapshot, bloat from
// every snapshot. Snapshots are read through temp copies and never modified.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RobinDb } from '../../system/brain/memory/db.ts';
import { readHeadCaptures } from '../copy/heads.ts';
import { openRouteLedger } from '../copy/routes.ts';
import { type FixtureMeta, readFixture } from '../render/fixture.ts';
import { type StateMetrics, scoreTimeline } from './metrics.ts';
import { readHeadTimeline, withSnapshotCopy } from './timeline.ts';

export interface Bloat {
  heads: number;
  pending: number;
  conflicted: number;
  entities: number;
  vectors: number;
  liveBytes: number;
}
export interface CopyScore {
  arm: string;
  /** Copy-days with a result in results.jsonl; less than fixtureHorizonDays for a partial run. */
  completedDays: number;
  fixtureHorizonDays: number;
  metrics: StateMetrics;
  bloat: { day: number; bloat: Bloat }[];
}

const SNAPSHOT = /^day-(\d{4,})\.sqlite$/;

const count = (db: RobinDb, sql: string): number => (db.prepare(sql).get() as { n: number }).n;

export function measureBloat(db: RobinDb): Bloat {
  const pragma = (name: string) => db.pragma(name, { simple: true }) as number;
  return {
    heads: count(
      db,
      `SELECT COUNT(*) AS n FROM (
         SELECT json_extract(payload,'$.retracted') AS retracted,
                ROW_NUMBER() OVER (PARTITION BY json_extract(payload,'$.topic')
                                   ORDER BY ts DESC, id DESC) AS rn
           FROM events WHERE kind = 'belief.update' AND json_extract(payload,'$.topic') IS NOT NULL
       ) WHERE rn = 1 AND COALESCE(retracted, 0) = 0`,
    ),
    pending: count(db, `SELECT COUNT(*) AS n FROM belief_candidates WHERE status = 'pending'`),
    conflicted: count(
      db,
      `SELECT COUNT(*) AS n FROM belief_candidates WHERE status = 'conflicted'`,
    ),
    entities: count(db, `SELECT COUNT(*) AS n FROM entities`),
    vectors: count(db, `SELECT COUNT(*) AS n FROM events_vec`),
    liveBytes: (pragma('page_count') - pragma('freelist_count')) * pragma('page_size'),
  };
}

export function scoreCopy(sandboxRoot: string, fixtureDir: string): CopyScore {
  const run = JSON.parse(readFileSync(join(sandboxRoot, 'run.json'), 'utf8')) as {
    arm: { name: string };
    fixture: FixtureMeta;
  };
  const { meta, script } = readFixture(fixtureDir);
  if (run.fixture.scriptSha !== meta.scriptSha) {
    throw new Error(
      `fixture mismatch: run used script ${run.fixture.scriptSha}, ${fixtureDir} has ${meta.scriptSha}`,
    );
  }
  const dir = join(sandboxRoot, 'snapshots');
  const snaps = (existsSync(dir) ? readdirSync(dir) : [])
    .map((f) => ({ f, m: SNAPSHOT.exec(f) }))
    .filter((x): x is { f: string; m: RegExpExecArray } => x.m !== null)
    .map(({ f, m }) => ({ day: Number(m[1]), path: join(dir, f) }))
    .sort((a, b) => a.day - b.day);
  const newest = snaps.at(-1);
  if (!newest) throw new Error(`no snapshots under ${dir}`);

  const routes = openRouteLedger(join(sandboxRoot, 'routes.jsonl')).all();
  // Captures after the newest snapshot (a run that died mid-way) are left out.
  const captures = readHeadCaptures(sandboxRoot)
    .filter((c) => c.day <= newest.day)
    .map((c) => c.rows);
  const records = readHeadTimeline(newest.path, script, routes, captures);
  const metrics = scoreTimeline(script, records, meta.startDate, newest.day + 1);
  const bloat = snaps.map(({ day, path }) => ({
    day,
    bloat: withSnapshotCopy(path, measureBloat),
  }));
  const resultsPath = join(sandboxRoot, 'results.jsonl');
  const completedDays = existsSync(resultsPath)
    ? readFileSync(resultsPath, 'utf8')
        .split('\n')
        .filter((l) => l.trim().length > 0).length
    : 0;
  const score: CopyScore = {
    arm: run.arm.name,
    completedDays,
    fixtureHorizonDays: meta.horizonDays,
    metrics,
    bloat,
  };
  writeFileSync(join(sandboxRoot, 'score.json'), `${JSON.stringify(score, null, 2)}\n`);
  return score;
}
