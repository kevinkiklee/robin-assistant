import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { closeDb, openDb, type RobinDb } from '../../memory/db.ts';
import { isPersonalDomain } from '../../memory/domains.ts';
import { ingest } from '../../memory/ingest.ts';
import { allMigrations, applyMigrations } from '../../memory/migrations/index.ts';
import {
  careerScout,
  financeScout,
  healthScout,
  SCOUT_CONFIGS,
  socialScout,
  travelScout,
} from './configs.ts';

function freshDb(): RobinDb {
  const dir = mkdtempSync(join(tmpdir(), 'robin-scout-configs-'));
  mkdirSync(join(dir, 'state', 'db'), { recursive: true });
  const db = openDb(join(dir, 'state', 'db', 'robin.sqlite'));
  applyMigrations(db, allMigrations);
  return db;
}

const NOW = new Date('2027-03-01T12:00:00Z');
/** Inside every scout's lookback window relative to NOW. */
const FRESH_TS = '2027-02-27T00:00:00.000Z';
/** Outside every scout's lookback window relative to NOW. */
const OLD_TS = '2026-12-15T00:00:00.000Z';

/** Seed one event with a pinned ts (ingest stamps the current time). */
function seedEvent(
  db: RobinDb,
  input: { kind: string; source: string; payload: Record<string, unknown>; ts?: string },
): void {
  const { eventId } = ingest(db, null, {
    kind: input.kind,
    source: input.source,
    payload: input.payload,
  });
  db.prepare(`UPDATE events SET ts = ? WHERE id = ?`).run(input.ts ?? FRESH_TS, eventId);
}

// ---------------------------------------------------------------------------
// Registry shape
// ---------------------------------------------------------------------------

test('scout configs: five configs, policy-key ids, real PERSONAL_DOMAINS members', () => {
  const ids = SCOUT_CONFIGS.map((c) => c.id).sort();
  assert.deepEqual(ids, ['career', 'finance', 'health', 'social', 'travel']);
  for (const c of SCOUT_CONFIGS) {
    assert.ok(isPersonalDomain(c.domain), `${c.id} domain '${c.domain}' is a real domain`);
    assert.ok(c.sources.length > 0, `${c.id} has sources`);
    assert.ok(c.guidance.trim().length > 0, `${c.id} has guidance`);
  }
  // career IS a PERSONAL_DOMAINS member — used directly.
  assert.equal(careerScout.domain, 'career');
  // There is NO 'social' member; relationships is the nearest existing domain.
  assert.equal(socialScout.domain, 'relationships');
  assert.equal(financeScout.domain, 'finance');
  assert.equal(healthScout.domain, 'health');
  assert.equal(travelScout.domain, 'travel');
});

test('scout configs: sources match the live event streams', () => {
  assert.deepEqual(
    financeScout.sources.map((s) => s.source),
    ['lunch_money', 'lunch_money_account_snapshot'],
  );
  assert.deepEqual(
    healthScout.sources.map((s) => s.source),
    ['whoop'],
  );
  assert.deepEqual(
    travelScout.sources.map((s) => s.source),
    ['google_calendar', 'weather'],
  );
  assert.deepEqual(
    careerScout.sources.map((s) => s.source),
    ['gmail'],
  );
  assert.deepEqual(
    socialScout.sources.map((s) => s.source),
    ['google_calendar', 'photowalks'],
  );
});

test('scout configs: travel guidance demands explicit expiresAt (windowed items)', () => {
  assert.match(travelScout.guidance, /expiresAt/);
});

test('scout configs: every digest returns null on an empty DB', () => {
  const db = freshDb();
  for (const c of SCOUT_CONFIGS) {
    const allSources = c.sources.map((s) => s.source);
    assert.equal(c.digest(db, NOW, allSources), null, `${c.id} digest null on empty DB`);
  }
  closeDb(db);
});

// ---------------------------------------------------------------------------
// finance
// ---------------------------------------------------------------------------

function seedTransaction(
  db: RobinDb,
  overrides: Partial<{
    payee: string;
    amount: number;
    category: string;
    date: string;
    deleted: boolean;
    is_income: boolean;
    external_id: string;
  }> = {},
): void {
  seedEvent(db, {
    kind: 'lunch_money.transaction',
    source: 'lunch_money',
    payload: {
      kind: 'transaction',
      external_id: overrides.external_id ?? `plaid:${Math.random().toString(36).slice(2)}`,
      payee: overrides.payee ?? 'Noodle Express',
      amount: overrides.amount ?? 18.4,
      is_income: overrides.is_income ?? false,
      currency: 'usd',
      category: overrides.category ?? 'Dining',
      date: overrides.date ?? '2027-02-27',
      status: 'uncleared',
      deleted: overrides.deleted ?? false,
    },
  });
}

function seedSnapshot(
  db: RobinDb,
  overrides: Partial<{
    display_name: string;
    type: string;
    balance: number;
    snapshot_date: string;
  }> = {},
): void {
  const name = overrides.display_name ?? 'Card A';
  const date = overrides.snapshot_date ?? '2027-03-01';
  seedEvent(db, {
    kind: 'lunch_money.account_snapshot',
    source: 'lunch_money_account_snapshot',
    payload: {
      kind: 'account_snapshot',
      external_id: `lm_account_snap:plaid:${name}:${date}`,
      display_name: name,
      type: overrides.type ?? 'credit',
      balance: overrides.balance ?? -180.25,
      currency: 'usd',
      snapshot_date: date,
    },
  });
}

test('finance digest: payee grouping with counts + totals; old/deleted excluded', () => {
  const db = freshDb();
  seedTransaction(db, { payee: 'Noodle Express', amount: 20, date: '2027-02-26' });
  seedTransaction(db, { payee: 'Noodle Express', amount: 30, date: '2027-02-27' });
  seedTransaction(db, { payee: 'Old Payee', amount: 500, date: '2026-12-15' }); // outside 14d
  seedTransaction(db, { payee: 'Ghost Charge', amount: 99, date: '2027-02-27', deleted: true });
  seedSnapshot(db, { balance: -100.5, snapshot_date: '2027-01-30' });
  seedSnapshot(db, { balance: -180.25, snapshot_date: '2027-03-01' });

  const digest = financeScout.digest(db, NOW, ['lunch_money', 'lunch_money_account_snapshot']);
  assert.ok(digest, 'digest rendered');
  assert.match(digest, /Noodle Express ×2 \$50\.00/, 'payee grouped with count + total');
  assert.match(digest, /Card A/, 'account balance line');
  assert.match(digest, /-180\.25/, 'latest balance');
  assert.match(digest, /-100\.5/, 'earlier balance for drift comparison');
  assert.ok(!digest.includes('Old Payee'), 'transactions outside 14d excluded');
  assert.ok(!digest.includes('Ghost Charge'), 'deleted transactions excluded');
  closeDb(db);
});

test('finance digest: a stale source is omitted from the render', () => {
  const db = freshDb();
  seedTransaction(db, { payee: 'Noodle Express', amount: 20, date: '2027-02-26' });
  seedSnapshot(db, { display_name: 'Card A' });

  // Snapshot source stale this pass → only the transaction section renders.
  const digest = financeScout.digest(db, NOW, ['lunch_money']);
  assert.ok(digest);
  assert.match(digest, /Noodle Express/);
  assert.ok(!digest.includes('Card A'), 'stale snapshot source not rendered');
  closeDb(db);
});

// ---------------------------------------------------------------------------
// health
// ---------------------------------------------------------------------------

test('health digest: recovery/sleep/workout aggregates from the last 14d', () => {
  const db = freshDb();
  seedEvent(db, {
    kind: 'whoop.recovery',
    source: 'whoop',
    payload: {
      kind: 'recovery',
      external_id: 'whoop:recovery:1',
      streak: { metric: 'recovery_below_50', days: 3 },
      score: { recovery_score: 46 },
    },
  });
  seedEvent(db, {
    kind: 'whoop.recovery',
    source: 'whoop',
    payload: {
      kind: 'recovery',
      external_id: 'whoop:recovery:2',
      score: { recovery_score: 66 },
    },
  });
  seedEvent(db, {
    kind: 'whoop.sleep',
    source: 'whoop',
    payload: {
      kind: 'sleep',
      external_id: 'whoop:sleep:1',
      nap: false,
      score: {
        sleep_performance_percentage: 63,
        stage_summary: { total_in_bed_time_milli: 7 * 3_600_000 },
      },
    },
  });
  seedEvent(db, {
    kind: 'whoop.workout',
    source: 'whoop',
    payload: {
      kind: 'workout',
      external_id: 'whoop:workout:1',
      sport_name: 'walking',
      score: { strain: 4.5 },
    },
  });
  // Outside the window: must not shift the aggregates.
  seedEvent(db, {
    kind: 'whoop.recovery',
    source: 'whoop',
    payload: { kind: 'recovery', external_id: 'whoop:recovery:old', score: { recovery_score: 1 } },
    ts: OLD_TS,
  });

  const digest = healthScout.digest(db, NOW, ['whoop']);
  assert.ok(digest);
  assert.match(digest, /recovery/i);
  assert.match(digest, /56/, 'mean recovery over the two in-window scores (46+66)/2');
  assert.match(digest, /below 50: 1/, 'days below 50 counted');
  assert.match(digest, /recovery_below_50 ×3d/, 'latest streak surfaced');
  assert.match(digest, /63/, 'sleep performance mean');
  assert.match(digest, /7\.0h/, 'time in bed rendered in hours');
  assert.match(digest, /walking ×1/, 'workout sport breakdown');
  closeDb(db);
});

test('health digest: null when no whoop rows fall inside the window', () => {
  const db = freshDb();
  seedEvent(db, {
    kind: 'whoop.recovery',
    source: 'whoop',
    payload: { kind: 'recovery', external_id: 'whoop:recovery:old', score: { recovery_score: 50 } },
    ts: OLD_TS,
  });
  assert.equal(healthScout.digest(db, NOW, ['whoop']), null);
  closeDb(db);
});

// ---------------------------------------------------------------------------
// travel
// ---------------------------------------------------------------------------

function seedCalendarEvent(
  db: RobinDb,
  overrides: Partial<{
    id: string;
    summary: string;
    start: string;
    location: string;
    status: string;
    attendees: number;
  }> = {},
): void {
  seedEvent(db, {
    kind: 'integration.google_calendar.event',
    source: 'google_calendar',
    payload: {
      id: overrides.id ?? `cal-${Math.random().toString(36).slice(2)}`,
      summary: overrides.summary ?? 'Board game night — TENTATIVE',
      start: overrides.start ?? '2027-03-06T09:00:00-05:00',
      end: '2027-03-06T17:00:00-05:00',
      location: overrides.location,
      attendees: overrides.attendees ?? 0,
      status: overrides.status ?? 'confirmed',
    },
  });
}

test('travel digest: next-30d calendar items + season note; cancelled/past excluded; re-emits deduped', () => {
  const db = freshDb();
  seedCalendarEvent(db, {
    id: 'games',
    summary: 'Board game night — TENTATIVE',
    start: '2027-03-06T09:00:00-05:00',
    location: 'Rook & Pawn Café',
  });
  // Re-emit of the SAME calendar event (changed time) — newest emission must win, once.
  seedCalendarEvent(db, {
    id: 'games',
    summary: 'Board game night — Rook & Pawn Café',
    start: '2027-03-06T13:30:00-05:00',
    location: 'Rook & Pawn Café',
  });
  seedCalendarEvent(db, { id: 'past', summary: 'Past thing', start: '2027-02-20T10:00:00-05:00' });
  seedCalendarEvent(db, {
    id: 'gone',
    summary: 'Cancelled thing',
    start: '2027-03-10T10:00:00-05:00',
    status: 'cancelled',
  });
  seedCalendarEvent(db, {
    id: 'far',
    summary: 'Beyond thirty days',
    start: '2027-04-20T10:00:00-04:00',
  });
  seedEvent(db, {
    kind: 'weather.current',
    source: 'weather',
    payload: { kind: 'current', location: 'Cedarvale', temp_f: 58.0, desc: 'overcast' },
  });

  const digest = travelScout.digest(db, NOW, ['google_calendar', 'weather']);
  assert.ok(digest);
  assert.match(digest, /Board game night — Rook & Pawn Café/, 'newest re-emit wins');
  assert.ok(!digest.includes('TENTATIVE'), 'superseded emission of the same event dropped');
  assert.ok(!digest.includes('Past thing'), 'past items excluded');
  assert.ok(!digest.includes('Cancelled thing'), 'cancelled items excluded');
  assert.ok(!digest.includes('Beyond thirty days'), 'items past 30d excluded');
  assert.match(digest, /Cedarvale/, 'weather context rendered');
  assert.match(digest, /spring/i, 'season note rendered');
  closeDb(db);
});

test('travel digest: weather omitted when stale; null without upcoming calendar items', () => {
  const db = freshDb();
  seedCalendarEvent(db, { id: 'games', start: '2027-03-06T09:00:00-05:00' });
  seedEvent(db, {
    kind: 'weather.current',
    source: 'weather',
    payload: { kind: 'current', location: 'Cedarvale', temp_f: 58.0, desc: 'overcast' },
  });

  const noWeather = travelScout.digest(db, NOW, ['google_calendar']);
  assert.ok(noWeather);
  assert.ok(!noWeather.includes('Cedarvale'), 'stale weather source not rendered');

  // Weather alone is context, not a travel signal — no calendar items → null.
  const db2 = freshDb();
  seedEvent(db2, {
    kind: 'weather.current',
    source: 'weather',
    payload: { kind: 'current', location: 'Cedarvale', temp_f: 58.0, desc: 'overcast' },
  });
  assert.equal(travelScout.digest(db2, NOW, ['google_calendar', 'weather']), null);
  closeDb(db);
  closeDb(db2);
});

// ---------------------------------------------------------------------------
// career — privacy hard rule: subjects + sender-domains with counts, NEVER bodies
// ---------------------------------------------------------------------------

const BODY_SENTINEL = 'CONFIDENTIAL-BODY-TEXT-DO-NOT-RENDER';

function seedGmail(
  db: RobinDb,
  overrides: Partial<{ from: string; subject: string; ts: string }> = {},
): void {
  seedEvent(db, {
    kind: 'integration.gmail.message',
    source: 'gmail',
    payload: {
      id: Math.random().toString(36).slice(2),
      threadId: Math.random().toString(36).slice(2),
      from: overrides.from ?? '"Amazon.com" <auto-confirm@amazon.com>',
      subject: overrides.subject ?? 'Ordered: 1 Kitchen item',
      // Defensive fixtures: the live gmail integration stores ONLY {id, threadId,
      // from, subject}, but if a future integration change ever adds body-ish
      // fields, the digest must STILL never render them.
      body: BODY_SENTINEL,
      snippet: BODY_SENTINEL,
      bodyText: BODY_SENTINEL,
    },
    ts: overrides.ts,
  });
}

test('career digest: sender-domains + subjects with counts — and NEVER body text', () => {
  const db = freshDb();
  seedGmail(db, { subject: 'Ordered: 1 Kitchen item' });
  seedGmail(db, { subject: 'Delivered: 1 Home item' });
  seedGmail(db, {
    from: 'Riley <riley@example.org>',
    subject: 'quillnote PR review — routing rules',
  });
  seedGmail(db, { from: 'Old Sender <old@stale.example>', subject: 'Ancient thing', ts: OLD_TS });

  const digest = careerScout.digest(db, NOW, ['gmail']);
  assert.ok(digest);
  assert.match(digest, /amazon\.com ×2/, 'sender-domain grouped with count');
  assert.match(digest, /example\.org ×1/, 'second sender-domain counted');
  assert.match(digest, /Ordered: 1 Kitchen item/, 'subject text rendered');
  assert.match(digest, /quillnote PR review — routing rules/, 'subject text rendered');
  assert.ok(!digest.includes('stale.example'), 'messages outside 14d excluded');
  // The privacy hard rule.
  assert.ok(!digest.includes(BODY_SENTINEL), 'body text is NEVER rendered');
  closeDb(db);
});

test('career digest: null when no gmail messages fall inside the window', () => {
  const db = freshDb();
  seedGmail(db, { ts: OLD_TS });
  assert.equal(careerScout.digest(db, NOW, ['gmail']), null);
  closeDb(db);
});

// ---------------------------------------------------------------------------
// social
// ---------------------------------------------------------------------------

test('social digest: upcoming calendar items + photowalk events', () => {
  const db = freshDb();
  seedCalendarEvent(db, {
    id: 'dinner',
    summary: 'Dinner with Riley',
    start: '2027-03-04T19:00:00-05:00',
    attendees: 2,
  });
  seedEvent(db, {
    kind: 'photowalks.event',
    source: 'photowalks',
    payload: {
      kind: 'event',
      external_id: 'photowalk:https://meetup.example/1',
      title: 'Neighborhood Book Swap',
      date: '2027-03-20',
      time: '19:00',
      location: 'Elm Street Library',
      walk_source: 'www.meetup.com',
      category: 'walk',
    },
  });
  // Outside 30d — excluded.
  seedEvent(db, {
    kind: 'photowalks.event',
    source: 'photowalks',
    payload: {
      kind: 'event',
      external_id: 'photowalk:https://meetup.example/2',
      title: 'Far Future Meetup',
      date: '2027-06-01',
      time: '10:00',
    },
  });

  const digest = socialScout.digest(db, NOW, ['google_calendar', 'photowalks']);
  assert.ok(digest);
  assert.match(digest, /Dinner with Riley/);
  assert.match(digest, /2 attendees/, 'attendee count rendered for social reading');
  assert.match(digest, /Neighborhood Book Swap/);
  assert.match(digest, /Elm Street Library/);
  assert.ok(!digest.includes('Far Future Meetup'), 'photowalks past 30d excluded');
  closeDb(db);
});

test('social digest: photowalks alone still render; both sections empty → null', () => {
  const db = freshDb();
  seedEvent(db, {
    kind: 'photowalks.event',
    source: 'photowalks',
    payload: {
      kind: 'event',
      external_id: 'photowalk:https://meetup.example/1',
      title: 'Neighborhood Book Swap',
      date: '2027-03-20',
      time: '19:00',
    },
  });
  const digest = socialScout.digest(db, NOW, ['google_calendar', 'photowalks']);
  assert.ok(digest, 'photowalks-only digest renders (group-outing candidates)');
  assert.match(digest, /Neighborhood Book Swap/);

  const db2 = freshDb();
  assert.equal(socialScout.digest(db2, NOW, ['google_calendar', 'photowalks']), null);
  closeDb(db);
  closeDb(db2);
});
