// lab/sandbox/sim-time.test.ts
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { runDream } from '../../system/brain/cognition/dream.ts';
import { insertBeliefCandidate } from '../../system/brain/memory/belief-candidate.ts';
import { closeDb, openDb, type RobinDb } from '../../system/brain/memory/db.ts';
import { ingest } from '../../system/brain/memory/ingest.ts';
import { allMigrations, applyMigrations } from '../../system/brain/memory/migrations/index.ts';
import { resetTuning, setTuning } from '../../system/brain/memory/tuning.ts';
import {
  createSandbox,
  createSimClock,
  enterSandbox,
  type Sandbox,
  type SimClock,
} from './sandbox.ts';

const START = Date.parse('2027-02-01T14:00:00Z');
const LIFECYCLE = new Set(['expire', 'lifecycle'] as const);
// Expiry only: the lifecycle step would reject a 0.3-confidence inferred claim earlier, on threshold.
const EXPIRE_ONLY = new Set(['expire'] as const);
let exit: (() => void) | null = null;
let openedDb: RobinDb | null = null;
let current: Sandbox | null = null;

afterEach(() => {
  resetTuning();
  if (openedDb) closeDb(openedDb);
  openedDb = null;
  exit?.();
  exit = null;
  current?.dispose();
  current = null;
});

function setup(): { db: RobinDb; clock: SimClock } {
  const sb = createSandbox();
  current = sb;
  const clock = createSimClock(START);
  exit = enterSandbox(sb, clock);
  const db = openDb(sb.dbPath);
  openedDb = db;
  applyMigrations(db, allMigrations);
  const ev = ingest(db, null, {
    kind: 'session.captured',
    source: 'capture',
    content: 'Sim User decided on Juniper Lake.',
  });
  insertBeliefCandidate(db, {
    topic: 'spring-trip.route',
    claim: 'Spring trip goes to Juniper Lake',
    confidence: 0.9,
    sourceEventId: ev.eventId,
    provenance: 'first-party',
  });
  return { db, clock };
}

function heads(db: RobinDb): number {
  return (
    db.prepare(`SELECT COUNT(*) n FROM events WHERE kind = 'belief.update'`).get() as { n: number }
  ).n;
}

async function dreamAt(
  db: RobinDb,
  clock: SimClock,
  steps: ReadonlySet<'expire' | 'lifecycle'> = LIFECYCLE,
) {
  return runDream(db, null, new Date(clock.now()), { domainGating: false, steps });
}

test('sim time: candidate rows and events carry sim timestamps, not wall-clock', () => {
  const { db } = setup();
  const c = db.prepare('SELECT created_at FROM belief_candidates').get() as { created_at: string };
  const e = db.prepare('SELECT ts FROM events ORDER BY id LIMIT 1').get() as { ts: string };
  assert.equal(c.created_at, '2027-02-01 14:00:00');
  assert.equal(e.ts, '2027-02-01T14:00:00.000Z');
});

test('sim time: default 7-day gate: not promoted at day 6, promoted at day 8', async () => {
  const { db, clock } = setup();
  clock.advanceDays(6);
  await dreamAt(db, clock);
  assert.equal(heads(db), 0);
  clock.advanceDays(2);
  const r = await dreamAt(db, clock);
  assert.equal(r.candidatesPromoted, 1);
  assert.equal(heads(db), 1);
});

test('sim time: tuning promoteAgeDays=3 promotes at day 4', async () => {
  setTuning({ promoteAgeDays: 3 });
  const { db, clock } = setup();
  clock.advanceDays(4);
  const r = await dreamAt(db, clock);
  assert.equal(r.candidatesPromoted, 1);
});

test('sim time: a pending candidate is rejected after 14 sim-days, not at 13', async () => {
  const { db, clock } = setup();
  const { id } = insertBeliefCandidate(db, {
    topic: 'gear.wishlist',
    claim: 'Maybe wants a camp stove someday',
    confidence: 0.3,
    provenance: 'inferred',
  });
  const status = () =>
    (db.prepare('SELECT status FROM belief_candidates WHERE id = ?').get(id) as { status: string })
      .status;
  clock.advanceDays(13);
  await dreamAt(db, clock, EXPIRE_ONLY);
  assert.equal(status(), 'pending');
  clock.advanceDays(2);
  await dreamAt(db, clock, EXPIRE_ONLY);
  assert.equal(status(), 'rejected');
});
