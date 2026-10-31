import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { closeDb, openDb, type RobinDb } from '../../memory/db.ts';
import { ingest } from '../../memory/ingest.ts';
import { allMigrations, applyMigrations } from '../../memory/migrations/index.ts';
import { getLinkCursor } from './cursor.ts';
import { runRecommendationLinker } from './linker.ts';
import { getRecommendation, insertRecommendation } from './store.ts';

function freshDb(): RobinDb {
  const dir = mkdtempSync(join(tmpdir(), 'robin-rec-linker-'));
  mkdirSync(join(dir, 'state', 'db'), { recursive: true });
  const db = openDb(join(dir, 'state', 'db', 'robin.sqlite'));
  applyMigrations(db, allMigrations);
  return db;
}

/** Render a Date in SQLite-utc form (matches the store's column format). */
function sqliteUtc(d: Date): string {
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * Seed a real `events` row whose kind is in BEHAVIORAL_SIGNAL_KINDS, with a controllable
 * timestamp. `ingest` forces ts=now, so we ingest then back-date the row to `at`. A
 * `lunch_money.transaction` payload's `merchant` becomes the normalized signal `object`.
 */
function seedPurchaseSignal(db: RobinDb, merchant: string, at: Date): number {
  const { eventId } = ingest(db, null, {
    kind: 'lunch_money.transaction',
    source: 'lunch_money',
    payload: { merchant },
  });
  db.prepare(`UPDATE events SET ts = ? WHERE id = ?`).run(at.toISOString(), eventId);
  return eventId;
}

const NOW = new Date('2026-06-17T12:00:00.000Z');

test('disabled → skip, no mutations', async () => {
  const db = freshDb();
  const { id } = insertRecommendation(db, {
    subject: 'Acme kettle',
    claim: 'buy it',
    domain: 'finance',
  });
  seedPurchaseSignal(db, 'Acme kettle', NOW);

  const res = await runRecommendationLinker(db, { enabled: false, now: NOW });
  assert.deepEqual(res, {
    linked: 0,
    expired: 0,
    held: 0,
    contrary: 0,
    emitted: 0,
    openAfter: 0,
    skipped: true,
  });
  // The rec is untouched, the cursor never advanced.
  assert.equal(getRecommendation(db, id)?.status, 'open');
  assert.equal(getLinkCursor(db), 0);
  closeDb(db);
});

test('open rec + matching purchase signal → acted, action_event_id set, one event emitted, lagDays ≥ 0', async () => {
  const db = freshDb();
  // Rec created two days before the action so lagDays > 0.
  const createdAt = sqliteUtc(new Date('2026-06-15T12:00:00.000Z'));
  const { id } = insertRecommendation(db, {
    subject: 'Acme kettle',
    claim: 'buy it for reach',
    verdict: 'buy',
    domain: 'finance',
  });
  db.prepare(`UPDATE recommendations SET created_at = ? WHERE id = ?`).run(createdAt, id);
  seedPurchaseSignal(db, 'Acme kettle', NOW);

  const res = await runRecommendationLinker(db, { now: NOW });
  assert.equal(res.linked, 1);
  assert.equal(res.emitted, 1);
  assert.equal(res.expired, 0);
  assert.equal(res.skipped, false);

  const rec = getRecommendation(db, id);
  assert.equal(rec?.status, 'acted');
  assert.equal(rec?.outcome, 'acted');
  assert.ok(rec?.actionEventId, 'action_event_id wired to the emitted event');
  assert.match(rec?.evidence ?? '', /matched signal #/);

  // Exactly ONE behavior.recommendation_acted event was emitted, and it carries lagDays ≥ 0.
  const events = db
    .prepare(`SELECT payload FROM events WHERE kind = 'behavior.recommendation_acted'`)
    .all() as { payload: string }[];
  assert.equal(events.length, 1);
  const payload = JSON.parse(events[0].payload) as {
    lagDays: number;
    subject: string;
    verdict: string;
  };
  assert.ok(payload.lagDays >= 0, 'lagDays is non-negative');
  assert.ok(payload.lagDays >= 1.9 && payload.lagDays <= 2.1, 'lagDays reflects the 2-day gap');
  assert.equal(payload.subject, 'Acme kettle');
  assert.equal(payload.verdict, 'buy');

  // The emitted event id is the rec's action_event_id.
  const emittedId = (
    db.prepare(`SELECT id FROM events WHERE kind = 'behavior.recommendation_acted'`).get() as {
      id: number;
    }
  ).id;
  assert.equal(rec?.actionEventId, emittedId);
  closeDb(db);
});

test('non-matching signal → rec stays open, no event', async () => {
  const db = freshDb();
  const { id } = insertRecommendation(db, {
    subject: 'Acme kettle',
    claim: 'buy it',
    domain: 'finance',
  });
  // A purchase that does not match the subject (different multi-token entity).
  seedPurchaseSignal(db, 'Whole Foods Market', NOW);

  const res = await runRecommendationLinker(db, { now: NOW });
  assert.equal(res.linked, 0);
  assert.equal(res.emitted, 0);
  assert.equal(getRecommendation(db, id)?.status, 'open');
  assert.equal(
    (
      db
        .prepare(`SELECT COUNT(*) c FROM events WHERE kind = 'behavior.recommendation_acted'`)
        .get() as {
        c: number;
      }
    ).c,
    0,
    'no recommendation_acted event emitted',
  );
  closeDb(db);
});

test('open rec past its expiry → expired/not_acted', async () => {
  const db = freshDb();
  const { id } = insertRecommendation(db, {
    subject: 'some old gear',
    claim: 'buy it',
    domain: 'finance',
    // Explicit expiry well before NOW.
    expiresAt: '2026-06-01 00:00:00',
  });

  const res = await runRecommendationLinker(db, { now: NOW });
  assert.equal(res.expired, 1);
  assert.equal(res.linked, 0);
  const rec = getRecommendation(db, id);
  assert.equal(rec?.status, 'expired');
  assert.equal(rec?.outcome, 'not_acted');
  assert.equal(rec?.actedAt, sqliteUtc(NOW), 'acted_at stamped with `now`');
  closeDb(db);
});

test('expiry uses defaultExpiryDays when no explicit expires_at', async () => {
  const db = freshDb();
  const { id } = insertRecommendation(db, { subject: 'aged rec', claim: 'c', domain: 'finance' });
  // Back-date creation 100 days before NOW and clear the stamped default expiry (insert
  // now stamps one) to exercise the legacy no-explicit-expiry fallback path;
  // defaultExpiryDays=90 → expired.
  const created = sqliteUtc(new Date(NOW.getTime() - 100 * 86_400_000));
  db.prepare(`UPDATE recommendations SET created_at = ?, expires_at = NULL WHERE id = ?`).run(
    created,
    id,
  );

  const res = await runRecommendationLinker(db, { now: NOW, defaultExpiryDays: 90 });
  assert.equal(res.expired, 1);
  assert.equal(getRecommendation(db, id)?.status, 'expired');

  // A fresh rec under the default window stays open.
  const fresh = insertRecommendation(db, { subject: 'fresh rec', claim: 'c', domain: 'finance' });
  const res2 = await runRecommendationLinker(db, { now: NOW, defaultExpiryDays: 90 });
  assert.equal(res2.expired, 0);
  assert.equal(getRecommendation(db, fresh.id)?.status, 'open');
  closeDb(db);
});

test('out-of-window signal does not match (linkWindowDays bound)', async () => {
  const db = freshDb();
  const { id } = insertRecommendation(db, {
    subject: 'Acme kettle',
    claim: 'buy it',
    domain: 'finance',
  });
  // A matching purchase, but 100 days before NOW — outside a 60-day window.
  seedPurchaseSignal(db, 'Acme kettle', new Date(NOW.getTime() - 100 * 86_400_000));

  const res = await runRecommendationLinker(db, { now: NOW, linkWindowDays: 60 });
  assert.equal(res.linked, 0, 'out-of-window signal is ignored');
  assert.equal(getRecommendation(db, id)?.status, 'open');
  closeDb(db);
});

test('Kettle end-to-end: open rec "Acme kettle" + matching purchase → acted + emits the signal', async () => {
  const db = freshDb();
  const src = ingest(db, null, {
    kind: 'memory.recommendation',
    source: 'mcp',
    content: 'rec',
  });
  const createdAt = sqliteUtc(new Date('2026-06-16T20:00:00.000Z'));
  const { id } = insertRecommendation(db, {
    subject: 'Acme kettle',
    claim: 'Buy the Acme kettle for faster pour-over coffee.',
    reasoning: 'light and compact; minor quality cost',
    verdict: 'buy',
    domain: 'finance',
    confidence: 0.85,
    sourceEventId: src.eventId,
  });
  db.prepare(`UPDATE recommendations SET created_at = ? WHERE id = ?`).run(createdAt, id);
  // The operator bought it the next day.
  seedPurchaseSignal(db, 'Acme kettle', NOW);

  const res = await runRecommendationLinker(db, { now: NOW });
  assert.equal(res.linked, 1);
  assert.equal(res.emitted, 1);

  const rec = getRecommendation(db, id);
  assert.equal(rec?.status, 'acted');
  assert.equal(rec?.outcome, 'acted');

  // The emitted behavior.recommendation_acted carries the rec's identity for the habit engine.
  const ev = db
    .prepare(`SELECT payload FROM events WHERE kind = 'behavior.recommendation_acted'`)
    .get() as { payload: string };
  const payload = JSON.parse(ev.payload) as { subject: string; domain: string; verdict: string };
  assert.equal(payload.subject, 'Acme kettle');
  assert.equal(payload.domain, 'finance');
  assert.equal(payload.verdict, 'buy');
  closeDb(db);
});

test('linker records open_recs_count metric after each pass', async () => {
  const db = freshDb();
  insertRecommendation(db, { subject: 'Metric Probe Item', claim: 'x', domain: 'creative' });
  const result = await runRecommendationLinker(db, { now: new Date('2026-08-10T12:00:00Z') });
  assert.equal(result.openAfter, 1);
  const row = db
    .prepare(`SELECT value FROM metrics_daily WHERE metric='open_recs_count'`)
    .get() as { value: number };
  assert.equal(row.value, 1);
  closeDb(db);
});

test('the emitted recommendation_acted event is NOT re-matched on a second pass', async () => {
  const db = freshDb();
  const { id } = insertRecommendation(db, {
    subject: 'Acme kettle',
    claim: 'buy it',
    domain: 'finance',
  });
  seedPurchaseSignal(db, 'Acme kettle', NOW);

  // First pass resolves the rec and emits one behavior.recommendation_acted event whose
  // own `object` (the subject) WOULD match a fresh rec about the same subject.
  const first = await runRecommendationLinker(db, { now: NOW });
  assert.equal(first.linked, 1);
  assert.equal(first.emitted, 1);
  assert.equal(getRecommendation(db, id)?.status, 'acted');

  // A new open rec about the same subject. The only remaining unscanned event is the
  // linker's OWN emitted recommendation_acted (a provenance kind) — it must NOT resolve
  // the new rec, both because it's excluded by kind and because the cursor advanced past
  // the original purchase.
  const second = insertRecommendation(db, {
    subject: 'Acme kettle',
    claim: 'buy it again',
    domain: 'finance',
  });
  const res = await runRecommendationLinker(db, { now: NOW });
  assert.equal(res.linked, 0, 'emitted recommendation_acted is not re-matched');
  assert.equal(res.emitted, 0);
  assert.equal(getRecommendation(db, second.id)?.status, 'open');

  // Still exactly one recommendation_acted event total (no self-feed cascade).
  assert.equal(
    (
      db
        .prepare(`SELECT COUNT(*) c FROM events WHERE kind = 'behavior.recommendation_acted'`)
        .get() as {
        c: number;
      }
    ).c,
    1,
  );
  closeDb(db);
});

/** Seed a gmail message (subject in payload, snippet in content) at `at`. */
function seedEmail(db: RobinDb, subject: string, body: string, at: Date): number {
  const { eventId } = ingest(db, null, {
    kind: 'integration.gmail.message',
    source: 'gmail',
    content: body,
    payload: { subject, from: 'store@example.com' },
  });
  db.prepare(`UPDATE events SET ts = ? WHERE id = ?`).run(at.toISOString(), eventId);
  return eventId;
}

test('order email naming the product resolves a buy rec (merchant name never could)', async () => {
  const db = freshDb();
  const { id } = insertRecommendation(db, {
    subject: 'Acme Bread Box',
    claim: 'Buy a bread box for the counter.',
    verdict: 'buy',
    domain: 'home',
  });
  db.prepare(`UPDATE recommendations SET created_at = ? WHERE id = ?`).run(
    '2026-06-10 00:00:00',
    id,
  );
  seedPurchaseSignal(db, 'Amazon', NOW); // the transaction: merchant only
  const emailId = seedEmail(
    db,
    'Ordered 1 item: Kitchen & Dining',
    'Your order: Acme Bread Box (2-pack)',
    NOW,
  );

  const res = await runRecommendationLinker(db, { now: NOW });
  assert.equal(res.linked, 1);
  const rec = getRecommendation(db, id);
  assert.equal(rec?.status, 'acted');
  assert.match(rec?.evidence ?? '', new RegExp(`#${emailId}`));
  closeDb(db);
});

test('a newsletter mentioning the product is not a signal', async () => {
  const db = freshDb();
  const { id } = insertRecommendation(db, {
    subject: 'Acme Bread Box',
    claim: 'Buy it.',
    verdict: 'buy',
    domain: 'home',
  });
  seedEmail(db, 'Deals of the week', 'Acme Bread Box 20% off', NOW);
  const res = await runRecommendationLinker(db, { now: NOW });
  assert.equal(res.linked, 0);
  assert.equal(getRecommendation(db, id)?.status, 'open');
  closeDb(db);
});

test('calendar title mentioning a place resolves a try rec', async () => {
  const db = freshDb();
  const { id } = insertRecommendation(db, {
    subject: 'Quartz Falls',
    claim: 'Try Quartz at dawn.',
    verdict: 'try',
    domain: 'travel',
  });
  const { eventId } = ingest(db, null, {
    kind: 'integration.google_calendar.event',
    source: 'google_calendar',
    payload: { summary: 'Hike: Quartz Falls + Slate Falls' },
  });
  db.prepare(`UPDATE events SET ts = ? WHERE id = ?`).run(NOW.toISOString(), eventId);
  const res = await runRecommendationLinker(db, { now: NOW });
  assert.equal(res.linked, 1);
  assert.equal(getRecommendation(db, id)?.status, 'acted');
  closeDb(db);
});

test('skip rec + matching purchase → declined (contrary), no recommendation_acted event', async () => {
  const db = freshDb();
  const { id } = insertRecommendation(db, {
    subject: 'Acme kettle',
    claim: 'Skip the kettle for now.',
    verdict: 'skip',
    domain: 'finance',
  });
  seedPurchaseSignal(db, 'Acme kettle', NOW);
  const res = await runRecommendationLinker(db, { now: NOW });
  assert.equal(res.contrary, 1);
  assert.equal(res.linked, 0);
  assert.equal(res.emitted, 0);
  const rec = getRecommendation(db, id);
  assert.equal(rec?.status, 'declined');
  assert.equal(rec?.outcome, 'not_acted');
  assert.match(rec?.evidence ?? '', /contrary action/);
  const n = db
    .prepare(`SELECT count(*) AS n FROM events WHERE kind = 'behavior.recommendation_acted'`)
    .get() as { n: number };
  assert.equal(n.n, 0);
  closeDb(db);
});

test('skip/avoid/wait recs past expiry with nothing contrary → held, not expired', async () => {
  const db = freshDb();
  const ids = (['skip', 'avoid', 'wait'] as const).map(
    (verdict) =>
      insertRecommendation(db, {
        subject: `thing ${verdict}`,
        claim: 'no',
        verdict,
        domain: 'finance',
        expiresAt: '2026-06-01 00:00:00',
      }).id,
  );
  const res = await runRecommendationLinker(db, { now: NOW });
  assert.equal(res.held, 3);
  assert.equal(res.expired, 0);
  for (const id of ids) {
    const rec = getRecommendation(db, id);
    assert.equal(rec?.status, 'held');
    assert.match(rec?.evidence ?? '', /held/);
  }
  closeDb(db);
});

test('a calendar REMINDER about the thing is not an action', async () => {
  const db = freshDb();
  const { id } = insertRecommendation(db, {
    subject: 'Maple Library card',
    claim: 'Renew the library card.',
    verdict: 'try',
    domain: 'preferences',
  });
  const { eventId } = ingest(db, null, {
    kind: 'integration.google_calendar.event',
    source: 'google_calendar',
    payload: { summary: '⏰ Renew Maple Library card' },
  });
  db.prepare(`UPDATE events SET ts = ? WHERE id = ?`).run(NOW.toISOString(), eventId);
  const res = await runRecommendationLinker(db, { now: NOW });
  assert.equal(res.linked, 0);
  assert.equal(getRecommendation(db, id)?.status, 'open');
  closeDb(db);
});
