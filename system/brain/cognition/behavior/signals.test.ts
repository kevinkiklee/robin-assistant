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
  classifyCommerceEmail,
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
    payload: { merchant: 'Acme Baking Supply', amount: 599 },
  });
  assert.ok(sig);
  assert.equal(sig.action, 'purchase');
  assert.equal(sig.domain, 'finance');
  assert.equal(sig.object, 'Acme Baking Supply');
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
    payload: { subject: 'Acme stand mixer', domain: 'finance', verdict: 'buy', lagDays: 1 },
  });
  assert.ok(sig);
  assert.equal(sig.action, 'act_on_recommendation');
  assert.equal(sig.object, 'Acme stand mixer');
  assert.equal(sig.domain, 'finance'); // carried in the payload, not a fixed per-kind domain
  assert.equal(sig.actor, 'user'); // the operator acting on Robin's advice, not Robin's own output
  assert.equal(sig.context.verdict, 'buy');
  assert.ok(BEHAVIORAL_SIGNAL_KINDS.includes('behavior.recommendation_acted'));
});

test('the allowlist includes the calendar stream but not discovery or dead kinds', () => {
  assert.ok(isBehavioralSignalKind('integration.google_calendar.event'));
  // photowalks.event is a DISCOVERY scraper (public listings of
  // upcoming events) — the environment, not the operator attending. Never allowlist it.
  assert.ok(!isBehavioralSignalKind('photowalks.event'));
  // v2.google_calendar is the dead v2 import stream (last row 2026-05-26).
  assert.ok(!isBehavioralSignalKind('v2.google_calendar'));
});

test('normalizeSignal maps a calendar event to travel/schedule, lifting the summary', () => {
  // Realistic shape from the live google_calendar integration: the object lives
  // under `summary` (Google's field name), not `title`.
  const sig = normalizeSignal({
    id: 8,
    kind: 'integration.google_calendar.event',
    ts: '2027-02-20T15:00:00.000Z',
    actor: null,
    payload: {
      id: 'evt_abc123',
      summary: 'Knitting circle',
      start: '2027-03-06T13:00:00-05:00',
      end: '2027-03-06T15:30:00-05:00',
      location: 'Community hall, Room 2',
      attendees: 0,
      status: 'confirmed',
    },
  });
  assert.ok(sig);
  assert.equal(sig.domain, 'travel');
  assert.equal(sig.action, 'schedule');
  assert.equal(sig.object, 'Knitting circle');
  assert.equal(sig.actor, 'user');
  assert.equal(sig.sourceKind, 'integration.google_calendar.event');
});

test('a gmail-style received message is not a behavioral signal', () => {
  // Received mail is someone ELSE acting — excluded by design even though its
  // payload carries a `subject` pickObject could lift.
  const sig = normalizeSignal({
    id: 9,
    kind: 'integration.gmail.message',
    ts: '2027-02-21T10:00:00.000Z',
    actor: null,
    payload: { subject: 'Lunch on Friday?', from: 'friend@example.com' },
  });
  assert.equal(sig, null);
});

test('an order-confirmation email IS a purchase signal, carrying subject + body text', () => {
  const sig = normalizeSignal({
    id: 10,
    kind: 'integration.gmail.message',
    ts: '2026-10-01T12:00:00.000Z',
    actor: null,
    payload: { subject: 'Your Acme order has been received!', from: 'support@acme' },
    content: 'Order #000000 Product: 9-inch pie dish',
  });
  assert.ok(sig);
  assert.equal(sig.action, 'purchase');
  assert.equal(sig.domain, 'finance');
  assert.equal(sig.object, 'Your Acme order has been received!');
  assert.match(String(sig.context.text), /9-inch pie dish/);
});

test('a booking confirmation is a travel booking signal; returns/newsletters are not signals', () => {
  const booking = normalizeSignal({
    id: 11,
    kind: 'integration.gmail.message',
    ts: '2026-10-01T12:00:00.000Z',
    actor: null,
    payload: { subject: 'Your reservation is confirmed: Lakeside Lodge' },
  });
  assert.equal(booking?.action, 'book');
  assert.equal(booking?.domain, 'travel');
  for (const subject of [
    'Return request confirmed for Acme Desk Lamp...',
    'Our spring newsletter is here',
    'Your refund has been processed',
  ]) {
    const sig = normalizeSignal({
      id: 12,
      kind: 'integration.gmail.message',
      ts: '2026-10-01T12:00:00.000Z',
      actor: null,
      payload: { subject },
    });
    assert.equal(sig, null, subject);
  }
});

test('classifyCommerceEmail recognizes the live order/shipping subject shapes', () => {
  assert.equal(classifyCommerceEmail('Ordered 1 item: Desk Fan'), 'purchase');
  assert.equal(classifyCommerceEmail('Acme Order #000000'), 'purchase');
  assert.equal(classifyCommerceEmail('A shipment from order #1000 has been delivered'), 'purchase');
  assert.equal(classifyCommerceEmail('Order Confirmation for Sam from Acme Deli'), 'purchase');
  assert.equal(classifyCommerceEmail('Your receipt from Acme Cloud, Inc. #0000-0000'), 'purchase');
  assert.equal(classifyCommerceEmail('Your trip itinerary'), 'booking');
  assert.equal(classifyCommerceEmail('Urgent action required: pageview limit'), null);
});

test('a shipment.tracked row is a purchase signal whose object is the item line', () => {
  const sig = normalizeSignal({
    id: 13,
    kind: 'shipment.tracked',
    ts: '2027-02-22T12:00:00.000Z',
    actor: null,
    payload: { carrier: 'Amazon', item: 'Delivered 1 item: Acme Bread Box' },
  });
  assert.equal(sig?.action, 'purchase');
  assert.equal(sig?.object, 'Delivered 1 item: Acme Bread Box');
});

test('selectNewSignals lifts the content body for mention kinds only', () => {
  const db = freshDb();
  ingest(db, null, {
    kind: 'integration.gmail.message',
    source: 'gmail',
    content: 'Thanks for your order: Acme Bread Box',
    payload: { subject: 'Your order has shipped!' },
  });
  ingest(db, null, {
    kind: 'integration.gmail.message',
    source: 'gmail',
    content: 'see you friday',
    payload: { subject: 'Lunch?' },
  });
  const { signals } = selectNewSignals(db, 0, 100);
  assert.equal(signals.length, 1);
  assert.match(String(signals[0].context.text), /Acme Bread Box/);
  closeDb(db);
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
        decisions: [{ choice: 'buy the Acme stand mixer', reasoning: 'quiet and compact' }],
      },
    },
  });
  assert.ok(sig);
  assert.equal(sig.action, 'decide');
  assert.equal(sig.domain, 'preferences');
  assert.equal(sig.object, 'buy the Acme stand mixer');
  assert.equal(sig.context.reasoning, 'quiet and compact');
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
    payload: { merchant: 'Acme Baking Supply' },
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
  ingest(db, null, {
    kind: 'photowalks.event',
    source: 'photowalks',
    payload: { title: 'Neighborhood Book Swap', date: '2027-04-17' },
  });
  const e6 = ingest(db, null, {
    kind: 'integration.google_calendar.event',
    source: 'google_calendar',
    payload: { id: 'evt_1', summary: 'Dentist', start: '2026-08-20T09:00:00-04:00' },
  });

  const { signals, cursor } = selectNewSignals(db, 0, 100);
  assert.equal(signals.length, 4, 'only the 4 allowlisted events (photowalks listing skipped)');
  assert.deepEqual(
    signals.map((s) => s.sourceEventId),
    [e1.eventId, e3.eventId, e4.eventId, e6.eventId],
    'oldest-first by event id',
  );
  assert.equal(cursor, e6.eventId, 'cursor advances to the highest event id seen');

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
          { choice: 'buy stand mixer', reasoning: 'faster dough' },
          { choice: 'skip the hand whisk', reasoning: 'too slow' },
        ],
      },
    },
  });

  const { signals } = selectNewSignals(db, 0, 100);
  const fromSession = signals.filter((s) => s.sourceEventId === sess.eventId);
  assert.equal(fromSession.length, 2, 'one signal per extracted decision');
  assert.deepEqual(
    fromSession.map((s) => s.object),
    ['buy stand mixer', 'skip the hand whisk'],
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
