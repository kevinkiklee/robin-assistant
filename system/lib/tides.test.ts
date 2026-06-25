import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseTides, lowTideInWindow, nextTides } from './tides.ts';

// ---------------------------------------------------------------------------
// Fixture: one full day at Sandy Hook, NJ — 2 highs + 2 lows (roughly)
// Times intentionally spread so window and ordering tests are unambiguous.
// ---------------------------------------------------------------------------
const FIXTURE_JSON = {
  predictions: [
    { t: '2026-06-25 03:12', v: '0.421', type: 'L' }, // low 1 — early morning
    { t: '2026-06-25 09:40', v: '5.103', type: 'H' }, // high 1 — late morning
    { t: '2026-06-25 15:55', v: '0.891', type: 'L' }, // low 2 — mid-afternoon
    { t: '2026-06-25 22:08', v: '4.762', type: 'H' }, // high 2 — evening
  ],
};

// ---------------------------------------------------------------------------
// parseTides — basic
// ---------------------------------------------------------------------------
test('parseTides: parses fixture into 4 tides', () => {
  const tides = parseTides(FIXTURE_JSON);
  assert.equal(tides.length, 4);
});

test('parseTides: types are alternating L H L H', () => {
  const tides = parseTides(FIXTURE_JSON);
  assert.equal(tides[0].type, 'L');
  assert.equal(tides[1].type, 'H');
  assert.equal(tides[2].type, 'L');
  assert.equal(tides[3].type, 'H');
});

test('parseTides: heights round-trip correctly', () => {
  const tides = parseTides(FIXTURE_JSON);
  assert.ok(Math.abs(tides[0].heightFt - 0.421) < 0.001);
  assert.ok(Math.abs(tides[1].heightFt - 5.103) < 0.001);
  assert.ok(Math.abs(tides[2].heightFt - 0.891) < 0.001);
  assert.ok(Math.abs(tides[3].heightFt - 4.762) < 0.001);
});

test('parseTides: time parses as a valid Date', () => {
  const tides = parseTides(FIXTURE_JSON);
  for (const tide of tides) {
    assert.ok(tide.time instanceof Date);
    assert.ok(!isNaN(tide.time.getTime()));
  }
});

test('parseTides: times are in ascending order', () => {
  const tides = parseTides(FIXTURE_JSON);
  for (let i = 1; i < tides.length; i++) {
    assert.ok(tides[i].time.getTime() > tides[i - 1].time.getTime());
  }
});

// ---------------------------------------------------------------------------
// parseTides — defensive / garbage input
// ---------------------------------------------------------------------------
test('parseTides: null input → []', () => {
  assert.deepEqual(parseTides(null), []);
});

test('parseTides: empty object → []', () => {
  assert.deepEqual(parseTides({}), []);
});

test('parseTides: missing predictions key → []', () => {
  assert.deepEqual(parseTides({ other: 'stuff' }), []);
});

test('parseTides: empty predictions array → []', () => {
  assert.deepEqual(parseTides({ predictions: [] }), []);
});

test('parseTides: predictions is a string, not array → []', () => {
  assert.deepEqual(parseTides({ predictions: 'bad' }), []);
});

test('parseTides: skips entries with unparseable height', () => {
  const json = {
    predictions: [
      { t: '2026-06-25 03:12', v: 'NaN', type: 'L' },
      { t: '2026-06-25 09:40', v: '5.103', type: 'H' },
    ],
  };
  const tides = parseTides(json);
  assert.equal(tides.length, 1);
  assert.equal(tides[0].type, 'H');
});

test('parseTides: skips entries with bad type', () => {
  const json = {
    predictions: [
      { t: '2026-06-25 03:12', v: '0.421', type: 'X' },
      { t: '2026-06-25 09:40', v: '5.103', type: 'H' },
    ],
  };
  const tides = parseTides(json);
  assert.equal(tides.length, 1);
  assert.equal(tides[0].type, 'H');
});

test('parseTides: skips entries with invalid date string', () => {
  const json = {
    predictions: [
      { t: 'not-a-date', v: '0.421', type: 'L' },
      { t: '2026-06-25 09:40', v: '5.103', type: 'H' },
    ],
  };
  const tides = parseTides(json);
  assert.equal(tides.length, 1);
});

test('parseTides: skips null entries in predictions array', () => {
  const json = { predictions: [null, { t: '2026-06-25 09:40', v: '5.103', type: 'H' }] };
  const tides = parseTides(json);
  assert.equal(tides.length, 1);
});

// ---------------------------------------------------------------------------
// lowTideInWindow
// ---------------------------------------------------------------------------

// Helper: build a Date from "YYYY-MM-DD HH:mm" the same way tides.ts does.
function d(s: string): Date {
  return new Date(s.replace(' ', 'T'));
}

test('lowTideInWindow: finds low at 03:12 in a morning window', () => {
  const tides = parseTides(FIXTURE_JSON);
  // window: 02:00 – 07:00, should catch the 03:12 low
  const result = lowTideInWindow(tides, d('2026-06-25 02:00'), d('2026-06-25 07:00'));
  assert.ok(result !== null);
  assert.equal(result!.type, 'L');
  assert.ok(Math.abs(result!.heightFt - 0.421) < 0.001);
});

test('lowTideInWindow: returns null when no low inside window', () => {
  const tides = parseTides(FIXTURE_JSON);
  // window: 10:00 – 14:00, contains only the 09:40 HIGH — no low
  const result = lowTideInWindow(tides, d('2026-06-25 10:00'), d('2026-06-25 14:00'));
  assert.equal(result, null);
});

test('lowTideInWindow: window boundary is inclusive', () => {
  const tides = parseTides(FIXTURE_JSON);
  const low = tides.find((t) => t.type === 'L')!; // 03:12 low
  // window exactly equals the low tide time
  const result = lowTideInWindow(tides, low.time, low.time);
  assert.ok(result !== null);
});

test('lowTideInWindow: empty tides → null', () => {
  assert.equal(lowTideInWindow([], d('2026-06-25 00:00'), d('2026-06-25 23:59')), null);
});

// ---------------------------------------------------------------------------
// nextTides
// ---------------------------------------------------------------------------
test('nextTides: from before any tide returns first H and first L', () => {
  const tides = parseTides(FIXTURE_JSON);
  // from: midnight — before all 4 tides
  const { high, low } = nextTides(tides, d('2026-06-25 00:00'));
  assert.ok(high !== null && low !== null);
  assert.equal(high!.type, 'H');
  assert.equal(low!.type, 'L');
  // The earliest low (03:12) comes before the first high (09:40)
  assert.ok(low!.time.getTime() < high!.time.getTime());
});

test('nextTides: from after first low returns second high and first low still ahead', () => {
  const tides = parseTides(FIXTURE_JSON);
  // from: 04:00 — past the 03:12 low, but before everything else
  const { high, low } = nextTides(tides, d('2026-06-25 04:00'));
  assert.ok(high !== null && low !== null);
  // Next high is 09:40
  assert.ok(Math.abs(high!.heightFt - 5.103) < 0.001);
  // Next low is 15:55
  assert.ok(Math.abs(low!.heightFt - 0.891) < 0.001);
});

test('nextTides: from after last high returns null for high, null for low', () => {
  const tides = parseTides(FIXTURE_JSON);
  // from: after all tides (23:00)
  const { high, low } = nextTides(tides, d('2026-06-25 23:00'));
  assert.equal(high, null);
  assert.equal(low, null);
});

test('nextTides: strictly after — exact match is excluded', () => {
  const tides = parseTides(FIXTURE_JSON);
  const firstLow = tides[0]; // 03:12 low
  // asking "next after exactly 03:12" should skip that tide
  const { low } = nextTides(tides, firstLow.time);
  assert.ok(low !== null);
  assert.ok(low!.time.getTime() > firstLow.time.getTime());
});

test('nextTides: empty tides → both null', () => {
  const { high, low } = nextTides([], d('2026-06-25 12:00'));
  assert.equal(high, null);
  assert.equal(low, null);
});
