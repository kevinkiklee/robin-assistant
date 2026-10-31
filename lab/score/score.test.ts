import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { believe } from '../../system/brain/memory/belief.ts';
import { dayStartMs } from '../copy/day.ts';
import { readHeadCaptures, writeHeadCapture } from '../copy/heads.ts';
import { openRouteLedger } from '../copy/routes.ts';
import { runCopy } from '../copy/run-copy.ts';
import { type Rig, rig } from '../copy/test-rig.ts';
import { buildFixture } from '../render/fixture.ts';
import { claimSentence } from '../render/grammar.ts';
import { paramsWith } from '../script/params.ts';
import { generateProbes } from '../script/probes.ts';
import type { Disclosure, Script } from '../script/types.ts';
import { kaplanMeier } from './km.ts';
import { latencyObservations, scoreTimeline } from './metrics.ts';
import { type CopyScore, scoreCopy } from './score-copy.ts';
import { assertedAt, readHeadTimeline } from './timeline.ts';

test('km: no censoring → median and survival match the empirical curve', () => {
  const k = kaplanMeier([1, 2, 2, 4, 8].map((t) => ({ time: t, event: true })));
  assert.equal(k.median, 2);
  assert.equal(k.survivalAt['1'], 0.8);
  assert.equal(k.survivalAt['7'], 0.2);
});

test('km: censored observations shrink the risk set without counting as events', () => {
  const k = kaplanMeier([
    { time: 1, event: true },
    { time: 2, event: false },
    { time: 3, event: true },
    { time: 4, event: true },
  ]);
  // S(1)=3/4, S(3)=3/4·1/2=0.375, S(4)=0
  assert.equal(k.events, 3);
  assert.equal(k.censored, 1);
  assert.equal(k.survivalAt['1'], 0.75);
  assert.equal(k.median, 3);
});

test('km: never reaching 0.5 → median null', () => {
  // risk 4 → censor at 5 → S(6) = 1 − 1/3 ≈ 0.667, never ≤ 0.5
  const k = kaplanMeier([
    { time: 5, event: false },
    { time: 6, event: true },
    { time: 9, event: false },
    { time: 9, event: false },
  ]);
  assert.equal(k.median, null);
});

const START = '2027-01-04';
const H = 40;
const noon = (d: number) => dayStartMs(START, d) + 12 * 3_600_000;

function script(): Script {
  const d = (
    id: string,
    slot: string,
    value: string,
    day: number,
    extra: Partial<Disclosure> = {},
  ): Disclosure => ({
    id,
    slot,
    factId: `f-${id}`,
    value,
    clarity: 'explicit',
    channel: 'session',
    kind: 'state',
    lagDays: 0,
    day,
    minute: 600,
    sessionId: null,
    ...extra,
  });
  const s: Script = {
    seed: 0,
    horizonDays: H,
    startDate: START,
    slots: [
      {
        key: 'heron-marsh-trip',
        label: 'heron marsh trip',
        kind: 'trip',
        domain: 'travel',
        values: ['idea', 'planned', 'booked', 'dropped'],
        bait: false,
      },
      {
        key: 'headlamp-gear',
        label: 'headlamp gear',
        kind: 'gear',
        domain: 'creative',
        values: ['wanted', 'ordered', 'owned'],
        bait: true,
      },
    ],
    facts: [{ id: 'f-bait', slot: 'headlamp-gear', value: 'wanted', validFrom: 0, validTo: null }],
    changes: [],
    disclosures: [
      d('d0', 'heron-marsh-trip', 'idea', 1),
      d('d1', 'heron-marsh-trip', 'booked', 5),
      d('d2', 'headlamp-gear', 'wanted', 2, { clarity: 'hedged', kind: 'bait-talk' }),
    ],
    assistantCalls: [],
    sessions: [],
    probes: [],
  };
  s.probes = generateProbes(s);
  return s;
}

let r: Rig | null = null;
afterEach(() => {
  r?.done();
  r = null;
});

function say(day: number, topic: string, claim: string, offsetMs = 0): number {
  (r as Rig).clock.set(noon(day) + offsetMs);
  const res = believe((r as Rig).db, null, { topic, claim, confidence: 0.9 });
  assert.equal(res.blocked, undefined, `believe blocked: ${claim}`);
  return res.eventId;
}

function score(s: Script) {
  const snap = join((r as Rig).sb.root, 'snap.sqlite');
  (r as Rig).db.exec(`VACUUM INTO '${snap}'`);
  const recs = readHeadTimeline(snap, s, (r as Rig).routes.all());
  return { recs, m: scoreTimeline(s, recs, START, H) };
}

test('scorer: correct → stale → correct counts latency and one resurrection', {
  timeout: 60_000,
}, () => {
  r = rig(START);
  const s = script();
  say(1, 'heron-marsh-trip', claimSentence('heron marsh trip', 'idea'));
  say(6, 'heron-marsh-trip', claimSentence('heron marsh trip', 'booked'));
  say(12, 'heron-marsh-trip', claimSentence('heron marsh trip', 'idea'));
  say(14, 'heron-marsh-trip', claimSentence('heron marsh trip', 'booked'));
  const { m } = score(s);
  assert.equal(m.latency.n, 2);
  assert.equal(m.latency.events, 2); // idea fixed day 1 (0 d), booked fixed day 6 (1 d)
  assert.equal(m.resurrections, 1);
  assert.equal(m.staleness, 0);
  assert.equal(m.coverage, 1); // heron is the only explicit slot at day 39; it asserts booked
  assert.deepEqual(m.probeAccuracy.superseded, { correct: 2, total: 3 }); // day 12 asserts idea
});

test('scorer: two believes on one topic the same day keep only the newest value', {
  timeout: 60_000,
}, () => {
  r = rig(START);
  const s = script();
  const a = say(3, 'heron-marsh-trip', claimSentence('heron marsh trip', 'idea'));
  const b = say(3, 'heron-marsh-trip', claimSentence('heron marsh trip', 'planned'), 60_000);
  assert.equal(a, b);
  const ledger = openRouteLedger(join(r.sb.root, 'r2.jsonl'));
  ledger.add(a, 'direct-believe');
  ledger.add(b, 'direct-believe');
  assert.equal(ledger.all().size, 1);
  const { recs } = score(s);
  const heron = recs.filter((x) => x.slot === 'heron-marsh-trip');
  assert.equal(heron.length, 1);
  assert.equal(heron[0].value, 'planned');
});

test('scorer: a sloppy second topic asserting a superseded value makes the slot stale', {
  timeout: 60_000,
}, () => {
  r = rig(START);
  const s = script();
  say(6, 'heron-marsh-trip', claimSentence('heron marsh trip', 'booked'));
  say(6, 'heron-notes', claimSentence('heron marsh trip', 'idea'));
  const { recs, m } = score(s);
  assert.equal(
    new Set(recs.filter((x) => x.slot === 'heron-marsh-trip').map((x) => x.topic)).size,
    2,
  );
  assert.equal(m.staleness, 1);
});

test('scorer: bait owned and an unparseable head are phantoms', { timeout: 60_000 }, () => {
  r = rig(START);
  const s = script();
  say(3, 'headlamp-gear', claimSentence('headlamp gear', 'owned'));
  say(3, 'sim-hobby', 'Sim User enjoys long walks.');
  const { m } = score(s);
  assert.equal(m.records, 2);
  assert.equal(m.offCatalogHeads, 1);
  // Both current heads at day 39 (headlamp-gear: owned, sim-hobby: unparseable) are phantoms.
  assert.equal(m.phantomPer100, 100);
  assert.equal(m.phantomRecordsEver, 2);
  assert.equal(m.coverage, 0); // heron is knowable explicit at day 39 but asserts nothing
  assert.deepEqual(m.probeAccuracy['never-true'], { correct: 0, total: 1 });
});

test('scorer: phantomPer100 counts current heads at the horizon; bait owned needs no probe', {
  timeout: 60_000,
}, () => {
  r = rig(START);
  const s = script();
  s.probes = s.probes.filter((p) => p.kind !== 'never-true');
  say(3, 'headlamp-gear', claimSentence('headlamp gear', 'owned'));
  say(4, 'headlamp-gear', claimSentence('headlamp gear', 'wanted'));
  say(6, 'heron-marsh-trip', claimSentence('heron marsh trip', 'booked'));
  const { m } = score(s);
  assert.equal(m.records, 3);
  assert.equal(m.phantomRecordsEver, 1); // the day-3 'owned' record, with no never-true probe
  assert.equal(m.phantomPer100, 0); // heads at day 39: wanted, booked
  const empty = scoreTimeline(s, [], START, H);
  assert.equal(empty.phantomPer100, null);
  assert.equal(empty.coverage, 0);
});

test('scorer: route wrongness uses knowable at the record minute, not end of day', {
  timeout: 60_000,
}, () => {
  r = rig(START);
  const s = script(); // booked is disclosed on day 5 at minute 600
  const at = (minute: number, topic: string) => {
    (r as Rig).clock.set(dayStartMs(START, 5) + minute * 60_000);
    const id = believe((r as Rig).db, null, {
      topic,
      claim: claimSentence('heron marsh trip', 'idea'),
      confidence: 0.9,
    }).eventId;
    (r as Rig).routes.add(id, 'direct-believe');
  };
  at(500, 'heron-marsh-trip'); // before the disclosure: idea is still right
  at(700, 'heron-notes'); // after it: idea is stale
  const { m } = score(s);
  assert.deepEqual(m.routes['direct-believe'], { heads: 2, wrong: 1 });
});

test('latency: a value overtaken before it lands is censored the day before the newer one', () => {
  const s = script(); // idea day 1, booked day 5
  const none = () => new Set<string>();
  const obs = latencyObservations(s, none, H).filter((o) => o.slot === 'heron-marsh-trip');
  assert.deepEqual(
    obs.map((o) => [o.day, o.time, o.event]),
    [
      [1, 3, false], // observed days 1..4: next.day - 1 - day = 5 - 1 - 1
      [5, 34, false], // observed days 5..39
    ],
  );
});

test('scorer: route ledger hits and the timeline snapshot is never written in place', {
  timeout: 60_000,
}, () => {
  r = rig(START);
  const s = script();
  const id = say(6, 'heron-marsh-trip', claimSentence('heron marsh trip', 'booked'));
  r.routes.add(id, 'correction-believe');
  say(7, 'heron-notes', claimSentence('heron marsh trip', 'idea'));
  const snap = join(r.sb.root, 'snap.sqlite');
  r.db.exec(`VACUUM INTO '${snap}'`);
  const before = readFileSync(snap);
  const recs = readHeadTimeline(snap, s, r.routes.all());
  assert.ok(before.equals(readFileSync(snap)));
  assert.ok(!existsSync(`${snap}-wal`));
  const m = scoreTimeline(s, recs, START, H);
  assert.deepEqual(m.routes['correction-believe'], { heads: 1, wrong: 0 });
  assert.deepEqual(m.routes.other, { heads: 1, wrong: 1 });
});

test('scorer: a promotion overwritten the same local day by a scripted believe survives as a promotion', {
  timeout: 60_000,
}, () => {
  r = rig(START);
  const s = script();
  const day2 = dayStartMs(START, 2);
  // Day 1's dream promotes at 03:50 on day 2 ...
  r.clock.set(day2 + 230 * 60_000);
  const p = believe(r.db, null, {
    topic: 'heron-marsh-trip',
    claim: claimSentence('heron marsh trip', 'idea'),
    confidence: 0.9,
    sources: [1],
  });
  writeHeadCapture(r.db, r.sb.root, 1);
  // ... then day 2's job replays a 01:40 assistant believe onto the same row.
  r.clock.set(day2 + 100 * 60_000);
  const b = believe(r.db, null, {
    topic: 'heron-marsh-trip',
    claim: claimSentence('heron marsh trip', 'booked'),
    confidence: 0.9,
  });
  assert.equal(b.eventId, p.eventId, 'same-day upsert reuses the row');
  r.routes.add(b.eventId, 'direct-believe');
  const snap = join(r.sb.root, 'snap.sqlite');
  r.db.exec(`VACUUM INTO '${snap}'`);
  const captures = readHeadCaptures(r.sb.root);
  assert.deepEqual(
    captures.map((c) => c.day),
    [1],
  );
  const recs = readHeadTimeline(
    snap,
    s,
    r.routes.all(),
    captures.map((c) => c.rows),
  );
  const heron = recs.filter((x) => x.slot === 'heron-marsh-trip');
  assert.deepEqual(
    heron.map((x) => [x.value, x.route]),
    [
      ['idea', 'promotion'],
      ['booked', 'direct-believe'],
    ],
  );
  const m = scoreTimeline(s, recs, START, H);
  assert.deepEqual(m.routes.promotion, { heads: 1, wrong: 0 });
  // 'booked' at 01:40 on day 2: knowable is still 'idea' (booked is disclosed on day 5).
  assert.deepEqual(m.routes['direct-believe'], { heads: 1, wrong: 1 });
  // The overwrite is the day's head even though its ts precedes the promotion's.
  assert.deepEqual(
    [...(assertedAt(recs, dayStartMs(START, 3) - 1).get('heron-marsh-trip') ?? [])],
    ['booked'],
  );
  const without = readHeadTimeline(snap, s, r.routes.all());
  assert.equal(without.filter((x) => x.slot === 'heron-marsh-trip').length, 1);
});

test('scoreCopy: scores an inline copy run and writes score.json', {
  timeout: 120_000,
}, async () => {
  const fx = mkdtempSync(join(tmpdir(), 'lab-fx-'));
  buildFixture(fx, paramsWith({ horizonDays: 8 }), 51); // seed 51 promotes by day 7
  const out = mkdtempSync(join(tmpdir(), 'lab-run-'));
  const run = await runCopy({
    fixtureDir: fx,
    arm: { name: 'baseline' },
    outDir: out,
    mode: 'inline',
    livePaths: ['/nonexistent-live'],
  });
  const sc = scoreCopy(run.sandboxRoot, fx);
  assert.equal(sc.arm, 'baseline');
  assert.equal(sc.metrics.horizonDay, 8);
  assert.deepEqual(
    sc.bloat.map((b) => b.day),
    [6, 7],
  );
  assert.ok(sc.metrics.records > 0);
  assert.equal(sc.completedDays, 8);
  assert.equal(sc.fixtureHorizonDays, 8);
  assert.ok(sc.metrics.routes.promotion.heads > 0);
  assert.ok(sc.bloat.every((b) => b.bloat.liveBytes > 0));
  const written = JSON.parse(
    readFileSync(join(run.sandboxRoot, 'score.json'), 'utf8'),
  ) as CopyScore;
  assert.deepEqual(written, JSON.parse(JSON.stringify(sc)));
});
