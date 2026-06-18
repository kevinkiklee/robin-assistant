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
import { calibrate, recommendationsText } from './recommendations.ts';

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
    subject: 'Nikon Z TC-1.4x',
    claim: 'Buy the TC-1.4x for birding reach.',
    verdict: 'buy',
    domain: 'finance',
    confidence: 0.8,
  });
  resolveRecommendation(db, a.id, { status: 'acted', outcome: 'acted', actedAt: '2026-06-10' });
  const b = insertRecommendation(db, {
    subject: 'Viltrox 85 EVO',
    claim: 'Buy the Viltrox 85/2 EVO.',
    verdict: 'buy',
    domain: 'finance',
    confidence: 0.6,
  });
  resolveRecommendation(db, b.id, { status: 'acted', outcome: 'acted', actedAt: '2026-06-11' });
  const c = insertRecommendation(db, {
    subject: 'Some other lens',
    claim: 'Consider this lens.',
    domain: 'finance',
    confidence: 0.4,
  });
  resolveRecommendation(db, c.id, { status: 'expired', outcome: 'not_acted' });

  // creative: 1 open (not resolved → excluded from rate)
  insertRecommendation(db, {
    subject: 'Try long-exposure waterfalls',
    claim: 'Try a 6-stop ND for waterfalls.',
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
  assert.ok(text.includes('Nikon Z TC-1.4x'), `missing subject: ${text}`);
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
  assert.ok(text.includes('Try long-exposure waterfalls'));
  assert.ok(!text.includes('Nikon Z TC-1.4x'), 'acted rec leaked into open-filtered listing');
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
