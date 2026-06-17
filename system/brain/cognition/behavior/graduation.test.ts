import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { closeDb, openDb, type RobinDb } from '../../memory/db.ts';
import type { PersonalDomain } from '../../memory/domains.ts';
import { allMigrations, applyMigrations } from '../../memory/migrations/index.ts';
import { graduateHabit, meetsGraduationGate, NON_GRADUATING_DOMAINS } from './graduation.ts';
import { getHabit, insertHabit, setHabitStatus } from './habits-store.ts';
import type { Habit, PatternKind } from './types.ts';

function freshDb(): RobinDb {
  const dir = mkdtempSync(join(tmpdir(), 'robin-grad-'));
  mkdirSync(join(dir, 'state', 'db'), { recursive: true });
  const db = openDb(join(dir, 'state', 'db', 'robin.sqlite'));
  applyMigrations(db, allMigrations);
  return db;
}

const NOW = new Date('2026-06-17T00:00:00Z');

/** Build a habit that, by default, CLEARS the graduation gate at K=4 / X=3 weeks. */
function habit(overrides: Partial<Habit> = {}): Habit {
  return {
    id: 1,
    statement: 'tends to buy camera gear before a planned trip',
    domain: 'preferences' as PersonalDomain,
    patternKind: 'purchase' as PatternKind,
    confidence: 0.8,
    supportCount: 4,
    supportStreams: 2,
    contradictionCount: 0,
    evidenceEventIds: [],
    evidenceSummary: '',
    embedding: null,
    // first seen ~6 weeks ago (≥ 3 weeks), last reinforced today (recency current).
    firstSeen: '2026-05-06 00:00:00',
    lastSeen: '2026-06-17 00:00:00',
    lastReinforced: '2026-06-17 00:00:00',
    status: 'soft',
    graduatedBeliefId: null,
    createdAt: '2026-05-06 00:00:00',
    updatedAt: '2026-06-17 00:00:00',
    ...overrides,
  };
}

const CRITERIA = { graduationSupport: 4, graduationWeeks: 3, now: NOW };

test('meetsGraduationGate: true only when ALL criteria are met', () => {
  assert.equal(meetsGraduationGate(habit(), CRITERIA), true);
});

test('meetsGraduationGate: support K-1 → false', () => {
  assert.equal(meetsGraduationGate(habit({ supportCount: 3 }), CRITERIA), false);
});

test('meetsGraduationGate: a single stream → false (no single-stream graduation)', () => {
  assert.equal(meetsGraduationGate(habit({ supportStreams: 1 }), CRITERIA), false);
});

test('meetsGraduationGate: confidence below the high floor → false', () => {
  assert.equal(meetsGraduationGate(habit({ confidence: 0.4 }), CRITERIA), false);
});

test('meetsGraduationGate: window shorter than X weeks → false', () => {
  // first seen ~1 week ago, well under the 3-week sustained bar.
  assert.equal(meetsGraduationGate(habit({ firstSeen: '2026-06-10 00:00:00' }), CRITERIA), false);
});

test('meetsGraduationGate: stale recency → false', () => {
  // last reinforced ~3 months ago — no longer current even though the window is long.
  assert.equal(
    meetsGraduationGate(habit({ lastReinforced: '2026-03-01 00:00:00' }), CRITERIA),
    false,
  );
});

test('NON_GRADUATING_DOMAINS covers the sensitive set (§11)', () => {
  for (const d of ['health', 'finance', 'relationships']) {
    assert.equal(NON_GRADUATING_DOMAINS.has(d), true, `${d} is non-graduating`);
  }
  assert.equal(NON_GRADUATING_DOMAINS.has('preferences'), false);
});

test('graduateHabit: emits a preferences belief_candidate and returns its id', () => {
  const db = freshDb();
  const { id } = insertHabit(db, {
    statement: 'tends to shoot most at golden hour',
    domain: 'creative',
    patternKind: 'temporal',
    confidence: 0.8,
    supportCount: 5,
    supportStreams: 2,
  });
  const h = getHabit(db, id);
  assert.ok(h);

  return graduateHabit(db, h).then((res) => {
    assert.ok(res, 'a candidate was emitted');
    const cand = db
      .prepare(
        `SELECT topic, claim, domain, provenance, status FROM belief_candidates WHERE id = ?`,
      )
      .get(res.beliefCandidateId) as {
      topic: string;
      claim: string;
      domain: string;
      provenance: string;
      status: string;
    };
    assert.equal(cand.domain, 'preferences', 'candidate is in the preferences domain');
    assert.equal(cand.claim, 'tends to shoot most at golden hour', 'carries the habit statement');
    assert.equal(cand.provenance, 'inferred');
    assert.equal(cand.status, 'pending', 'flows through the normal promotion gate');

    // Caller wires the link; verify the store accepts it.
    setHabitStatus(db, id, 'graduated', res.beliefCandidateId);
    const after = getHabit(db, id);
    assert.equal(after?.status, 'graduated');
    assert.equal(after?.graduatedBeliefId, res.beliefCandidateId);
    closeDb(db);
  });
});

test('graduateHabit: does NOT write a belief head directly (only a candidate)', () => {
  const db = freshDb();
  const { id } = insertHabit(db, {
    statement: 'tends to prefer prime lenses for street work',
    domain: 'preferences',
    patternKind: 'preference',
    confidence: 0.75,
    supportCount: 4,
    supportStreams: 2,
  });
  const h = getHabit(db, id);
  assert.ok(h);
  const beliefsBefore = (
    db.prepare(`SELECT COUNT(*) AS n FROM events WHERE kind = 'belief.update'`).get() as {
      n: number;
    }
  ).n;

  return graduateHabit(db, h).then(() => {
    const beliefsAfter = (
      db.prepare(`SELECT COUNT(*) AS n FROM events WHERE kind = 'belief.update'`).get() as {
        n: number;
      }
    ).n;
    assert.equal(beliefsAfter, beliefsBefore, 'no belief head written — only a candidate');
    closeDb(db);
  });
});
