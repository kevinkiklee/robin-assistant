import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  insertRecommendation,
  listRecommendations,
  resolveRecommendation,
} from '../../brain/cognition/recommendations/store.ts';
import { closeDb, openDb, type RobinDb } from '../../brain/memory/db.ts';
import { allMigrations, applyMigrations } from '../../brain/memory/migrations/index.ts';
import { calibrate, dedupeText, planDedupe, recommendationsText } from './recommendations.ts';

function freshDb(): RobinDb {
  const dir = mkdtempSync(join(tmpdir(), 'robin-cli-recs-'));
  mkdirSync(join(dir, 'state', 'db'), { recursive: true });
  const db = openDb(join(dir, 'state', 'db', 'robin.sqlite'));
  applyMigrations(db, allMigrations);
  return db;
}

/** Seed a ledger with a known mix of outcomes for calibration assertions. */
function seedLedger(db: RobinDb): void {
  // finance: 2 acted, 1 expired → acted-rate 2/3
  const a = insertRecommendation(db, {
    subject: 'Acme kettle',
    claim: 'Buy the Acme kettle for faster pour-over.',
    verdict: 'buy',
    domain: 'finance',
    confidence: 0.8,
  });
  resolveRecommendation(db, a.id, { status: 'acted', outcome: 'acted', actedAt: '2026-06-10' });
  const b = insertRecommendation(db, {
    subject: 'Acme Stapler',
    claim: 'Buy the Acme Stapler.',
    verdict: 'buy',
    domain: 'finance',
    confidence: 0.6,
  });
  resolveRecommendation(db, b.id, { status: 'acted', outcome: 'acted', actedAt: '2026-06-11' });
  const c = insertRecommendation(db, {
    subject: 'Some other kettle',
    claim: 'Consider this lens.',
    domain: 'finance',
    confidence: 0.4,
  });
  resolveRecommendation(db, c.id, { status: 'expired', outcome: 'not_acted' });

  // creative: 1 open (not resolved → excluded from rate)
  insertRecommendation(db, {
    subject: 'Try a standing desk',
    claim: 'Try a sit-stand desk.',
    verdict: 'try',
    domain: 'creative',
    confidence: 0.5,
  });
}

test('recommendationsText lists recs and renders calibration matching the digest', () => {
  const db = freshDb();
  seedLedger(db);

  const text = recommendationsText(db);

  // Ledger rows present
  assert.ok(text.includes('Acme kettle'), `missing subject: ${text}`);
  assert.ok(text.includes('verdict=buy'), `missing verdict col: ${text}`);
  assert.ok(text.includes('[finance]'), `missing domain col: ${text}`);
  assert.ok(text.includes('outcome=acted'), `missing outcome col: ${text}`);

  // Calibration: 2/3 acted (67%), open 1, expired 1
  assert.ok(text.includes('Calibration:'));
  assert.ok(text.includes('2/3 acted (67%)'), `wrong acted-rate line: ${text}`);
  assert.ok(text.includes('open 1'), `wrong open count: ${text}`);
  // Top domains by resolved: finance 2/3 (creative has 0 resolved → excluded)
  assert.ok(text.includes('top domains: finance 2/3'), `wrong top domains: ${text}`);
  assert.ok(!text.includes('creative 0/'), 'unresolved domain leaked into calibration');

  closeDb(db);
});

test('calibrate matches the digest computation exactly', () => {
  const db = freshDb();
  seedLedger(db);
  const cal = calibrate(listRecommendations(db));
  assert.equal(cal.acted, 2);
  assert.equal(cal.expired, 1);
  assert.equal(cal.declined, 0);
  assert.equal(cal.open, 1);
  assert.ok(cal.actedRate !== null && Math.abs(cal.actedRate - 2 / 3) < 1e-9);
  assert.deepEqual(cal.byDomain, [{ domain: 'finance', acted: 2, resolved: 3 }]);
  closeDb(db);
});

test('--status filter narrows the listing but calibration covers the whole ledger', () => {
  const db = freshDb();
  seedLedger(db);
  const text = recommendationsText(db, { status: 'open' });
  // Only the open rec is listed
  assert.ok(text.includes('Try a standing desk'));
  assert.ok(!text.includes('Acme kettle'), 'acted rec leaked into open-filtered listing');
  // But calibration still reflects the whole ledger → 2/3 acted
  assert.ok(text.includes('2/3 acted'), `calibration should cover whole ledger: ${text}`);
  closeDb(db);
});

test('empty ledger prints the friendly message without throwing', () => {
  const db = freshDb();
  const text = recommendationsText(db);
  assert.equal(text, 'No recommendations recorded yet — Robin logs them as it advises you.');
  closeDb(db);
});

test('skip/avoid/wait recs are excluded from the acted-rate and tallied separately', () => {
  const db = freshDb();
  seedLedger(db);
  const s = insertRecommendation(db, {
    subject: 'Sigma fp',
    claim: 'skip',
    verdict: 'skip',
    domain: 'finance',
  });
  resolveRecommendation(db, s.id, { status: 'held', outcome: 'not_acted' });
  const w = insertRecommendation(db, {
    subject: 'Acme X1 II',
    claim: 'wait',
    verdict: 'wait',
    domain: 'finance',
  });
  resolveRecommendation(db, w.id, { status: 'expired', outcome: 'not_acted' });
  const a = insertRecommendation(db, {
    subject: 'Pine Ridge Trail',
    claim: 'avoid',
    verdict: 'avoid',
    domain: 'travel',
  });
  resolveRecommendation(db, a.id, { status: 'declined', outcome: 'not_acted' });

  const cal = calibrate(listRecommendations(db));
  // Act-type rate unchanged by the hold-type rows: still 2/3.
  assert.equal(cal.acted, 2);
  assert.equal(cal.expired, 1);
  assert.equal(cal.declined, 0);
  assert.deepEqual(cal.hold, { held: 1, contrary: 1, lapsed: 1, open: 0 });
  assert.deepEqual(cal.byDomain, [{ domain: 'finance', acted: 2, resolved: 3 }]);

  const text = recommendationsText(db);
  assert.ok(text.includes('2/3 acted (67%)'), text);
  assert.ok(
    text.includes('skip/avoid/wait (not in acted-rate): held 1, contrary 1, lapsed 1'),
    text,
  );
  closeDb(db);
});

test('dedupe: dry run plans groups (newest kept); --apply supersedes the rest', () => {
  const db = freshDb();
  const ids = ['Acme kettle', 'Acme kettle (refurbished)', 'acme kettle', 'Acme F1'].map(
    (subject) =>
      insertRecommendation(db, { subject, claim: 'c', verdict: 'avoid', domain: 'finance' }).id,
  );
  // Make creation order explicit: later index = newer.
  ids.forEach((id, n) => {
    db.prepare(`UPDATE recommendations SET created_at = ? WHERE id = ?`).run(
      `2026-09-0${n + 1} 00:00:00`,
      id,
    );
  });

  const plan = planDedupe(listRecommendations(db, { status: 'open' }));
  assert.equal(plan.length, 1);
  assert.equal(plan[0].keep.id, ids[2]);
  assert.deepEqual(plan[0].supersede.map((r) => r.id).sort(), [ids[0], ids[1]].sort());

  const dry = dedupeText(db);
  assert.match(dry, /1 duplicate group\(s\); 2 open rec\(s\) would be superseded/);
  assert.match(dry, /Dry run/);
  assert.equal(listRecommendations(db, { status: 'open' }).length, 4, 'dry run writes nothing');

  const applied = dedupeText(db, { apply: true });
  assert.match(applied, /2 open rec\(s\) superseded/);
  const open = listRecommendations(db, { status: 'open' }).map((r) => r.id);
  assert.deepEqual(open.sort(), [ids[2], ids[3]].sort());
  assert.match(
    listRecommendations(db).find((r) => r.id === ids[0])?.evidence ?? '',
    new RegExp(`superseded by recommendation #${ids[2]} \\(dedupe`),
  );
  assert.equal(dedupeText(db), 'No duplicate open recommendations.');
  closeDb(db);
});
