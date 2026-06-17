import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { closeDb, openDb, type RobinDb } from '../../memory/db.ts';
import { ingest } from '../../memory/ingest.ts';
import { allMigrations, applyMigrations } from '../../memory/migrations/index.ts';
import {
  BEHAVIORAL_SIGNAL_KINDS,
  isBehavioralSignalKind,
  normalizeSignal,
  selectNewSignals,
} from './signals.ts';

function freshDb(): RobinDb {
  const dir = mkdtempSync(join(tmpdir(), 'robin-signals-'));
  mkdirSync(join(dir, 'state', 'db'), { recursive: true });
  const db = openDb(join(dir, 'state', 'db', 'robin.sqlite'));
  applyMigrations(db, allMigrations);
  return db;
}

test('the allowlist excludes Spotify (flatfiles, not events) and dev kinds', () => {
  assert.ok(BEHAVIORAL_SIGNAL_KINDS.includes('lunch_money.transaction'));
  assert.ok(BEHAVIORAL_SIGNAL_KINDS.includes('lrc.catalog_summary'));
  assert.ok(BEHAVIORAL_SIGNAL_KINDS.includes('letterboxd.letterboxd_diary'));
  assert.ok(BEHAVIORAL_SIGNAL_KINDS.includes('whoop.recovery'));
  assert.ok(!BEHAVIORAL_SIGNAL_KINDS.some((k) => k.startsWith('spotify')));
  assert.ok(!isBehavioralSignalKind('biographer.extracted'));
  assert.ok(!isBehavioralSignalKind('session.captured'));
  assert.ok(isBehavioralSignalKind('whoop.sleep'));
});

test('normalizeSignal maps a purchase event to the finance domain', () => {
  const sig = normalizeSignal({
    id: 1,
    kind: 'lunch_money.transaction',
    ts: '2026-06-01T10:00:00.000Z',
    actor: null,
    payload: { merchant: 'B&H Photo', amount: 599 },
  });
  assert.ok(sig);
  assert.equal(sig.action, 'purchase');
  assert.equal(sig.domain, 'finance');
  assert.equal(sig.object, 'B&H Photo');
  assert.equal(sig.sourceEventId, 1);
  assert.equal(sig.sourceKind, 'lunch_money.transaction');
  assert.equal(sig.actor, 'user'); // Robin's own outputs are excluded (§11)
});

test('normalizeSignal maps an lrc shoot + a whoop aggregate to their domains', () => {
  const lrc = normalizeSignal({
    id: 2,
    kind: 'lrc.catalog_summary',
    ts: '2026-06-02T10:00:00.000Z',
    actor: null,
    payload: '{"photos": 120}',
  });
  assert.equal(lrc?.domain, 'creative');
  assert.equal(lrc?.action, 'shoot');

  const whoop = normalizeSignal({
    id: 3,
    kind: 'whoop.recovery',
    ts: '2026-06-02T11:00:00.000Z',
    actor: null,
    payload: { score: 71 },
  });
  assert.equal(whoop?.domain, 'health');
  assert.equal(whoop?.action, 'recovery');
});

test('normalizeSignal maps a recommendation_acted event with a payload-carried domain', () => {
  const sig = normalizeSignal({
    id: 7,
    kind: 'behavior.recommendation_acted',
    ts: '2026-06-17T10:00:00.000Z',
    actor: null,
    payload: { subject: 'Nikon Z TC-1.4x', domain: 'finance', verdict: 'buy', lagDays: 1 },
  });
  assert.ok(sig);
  assert.equal(sig.action, 'act_on_recommendation');
  assert.equal(sig.object, 'Nikon Z TC-1.4x');
  assert.equal(sig.domain, 'finance'); // carried in the payload, not a fixed per-kind domain
  assert.equal(sig.actor, 'user'); // Kevin acting on Robin's advice, not Robin's own output
  assert.equal(sig.context.verdict, 'buy');
  assert.ok(BEHAVIORAL_SIGNAL_KINDS.includes('behavior.recommendation_acted'));
});

test('normalizeSignal returns null for a non-behavioral event', () => {
  const sig = normalizeSignal({
    id: 4,
    kind: 'knowledge.doc',
    ts: '2026-06-02T10:00:00.000Z',
    actor: null,
    payload: {},
  });
  assert.equal(sig, null);
});

test('normalizeSignal lifts a biographer session decision from the payload', () => {
  const sig = normalizeSignal({
    id: 5,
    kind: 'session.captured',
    ts: '2026-06-03T10:00:00.000Z',
    actor: null,
    payload: {
      summary: {
        decisions: [{ choice: 'buy the TC-1.4x', reasoning: 'near-zero IQ loss for birding' }],
      },
    },
  });
  assert.ok(sig);
  assert.equal(sig.action, 'decide');
  assert.equal(sig.domain, 'preferences');
  assert.equal(sig.object, 'buy the TC-1.4x');
  assert.equal(sig.context.reasoning, 'near-zero IQ loss for birding');
});

test('a session with no decisions normalizes to null', () => {
  const sig = normalizeSignal({
    id: 6,
    kind: 'session.captured',
    ts: '2026-06-03T10:00:00.000Z',
    actor: null,
    payload: { summary: { decisions: [] } },
  });
  assert.equal(sig, null);
});

test('selectNewSignals pulls allowlisted events after a cursor, oldest-first', () => {
  const db = freshDb();
  // Three behavioral events + one ignored knowledge.doc.
  const e1 = ingest(db, null, {
    kind: 'lunch_money.transaction',
    source: 'lunch_money',
    payload: { merchant: 'B&H' },
  });
  ingest(db, null, { kind: 'knowledge.doc', source: 'docs', content: 'note' });
  const e3 = ingest(db, null, {
    kind: 'whoop.sleep',
    source: 'whoop',
    payload: { hours: 7.5 },
  });
  const e4 = ingest(db, null, {
    kind: 'lrc.catalog_summary',
    source: 'lrc',
    payload: { photos: 50 },
  });

  const { signals, cursor } = selectNewSignals(db, 0, 100);
  assert.equal(signals.length, 3, 'only the 3 allowlisted events');
  assert.deepEqual(
    signals.map((s) => s.sourceEventId),
    [e1.eventId, e3.eventId, e4.eventId],
    'oldest-first by event id',
  );
  assert.equal(cursor, e4.eventId, 'cursor advances to the highest event id seen');

  // Re-running with the returned cursor yields nothing new.
  const second = selectNewSignals(db, cursor, 100);
  assert.equal(second.signals.length, 0);
  assert.equal(second.cursor, cursor);
  closeDb(db);
});

test('selectNewSignals expands a session into one signal per decision', () => {
  const db = freshDb();
  const sess = ingest(db, null, {
    kind: 'session.captured',
    source: 'claude_code',
    payload: {
      summary: {
        decisions: [
          { choice: 'buy TC', reasoning: 'birding reach' },
          { choice: 'skip 2x on DX', reasoning: 'f/11 kills AF' },
        ],
      },
    },
  });

  const { signals } = selectNewSignals(db, 0, 100);
  const fromSession = signals.filter((s) => s.sourceEventId === sess.eventId);
  assert.equal(fromSession.length, 2, 'one signal per extracted decision');
  assert.deepEqual(
    fromSession.map((s) => s.object),
    ['buy TC', 'skip 2x on DX'],
  );
  closeDb(db);
});

test('selectNewSignals respects the limit', () => {
  const db = freshDb();
  for (let i = 0; i < 5; i++) {
    ingest(db, null, { kind: 'whoop.cycle', source: 'whoop', payload: { strain: 10 + i } });
  }
  const { signals } = selectNewSignals(db, 0, 2);
  assert.equal(signals.length, 2);
  closeDb(db);
});
