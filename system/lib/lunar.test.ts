import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type MoonInfo, moonInfo } from './lunar.ts';

// Reference observer: New York City (mid-northern latitude), east-positive lng.
const NYC = { lat: 40.7128, lng: -74.006 };

// Confirmed 2026 reference dates (UTC instants of the phase maxima):
//   Full Moon  — 2026-06-29 23:57 UTC (Strawberry Moon)
//   New Moon   — 2026-06-15 ~02:54 UTC
// Sources: astronomy.com / space.com / starwalk.space / hermetikon.com.
// We sample at local noon of the calendar day containing each maximum.
const FULL_MOON_DATE = new Date('2026-06-29T12:00:00Z');
const NEW_MOON_DATE = new Date('2026-06-15T12:00:00Z');

test('illumination ≈ 1.0 and phase "full" near the known full moon', () => {
  const info = moonInfo(NYC.lat, NYC.lng, FULL_MOON_DATE);
  assert.ok(
    info.illumination > 0.97,
    `expected >0.97 lit near full moon, got ${info.illumination.toFixed(4)}`,
  );
  assert.equal(info.phaseName, 'full');
});

test('illumination ≈ 0.0 and phase "new" near the known new moon', () => {
  const info = moonInfo(NYC.lat, NYC.lng, NEW_MOON_DATE);
  assert.ok(
    info.illumination < 0.03,
    `expected <0.03 lit near new moon, got ${info.illumination.toFixed(4)}`,
  );
  assert.equal(info.phaseName, 'new');
});

test('illumination waxes then wanes across a 30-day span (not monotonic)', () => {
  // Start at the new moon; over ~30 days the lit fraction should rise toward
  // full (~day 15) then fall again — strictly non-monotonic.
  const series: number[] = [];
  for (let d = 0; d < 30; d++) {
    const day = new Date(NEW_MOON_DATE.getTime() + d * 86400000);
    series.push(moonInfo(NYC.lat, NYC.lng, day).illumination);
  }
  const peak = Math.max(...series);
  const peakIdx = series.indexOf(peak);

  // Peak is interior (waxes into it, wanes out of it).
  assert.ok(peakIdx > 2 && peakIdx < 27, `peak index ${peakIdx} not interior`);
  // Peak is essentially full.
  assert.ok(peak > 0.97, `peak illumination ${peak.toFixed(4)} not near full`);
  // Rises before the peak and falls after it.
  assert.ok(series[peakIdx] > series[0], 'should wax from new moon to peak');
  assert.ok(series[peakIdx] > series[series.length - 1], 'should wane from peak to span end');

  // Confirm true non-monotonicity: at least one up-step AND one down-step.
  let hasUp = false;
  let hasDown = false;
  for (let i = 1; i < series.length; i++) {
    if (series[i] > series[i - 1]) hasUp = true;
    if (series[i] < series[i - 1]) hasDown = true;
  }
  assert.ok(hasUp && hasDown, 'illumination should both increase and decrease over the cycle');
});

test('moonrise advances by the daily lag (~25–80 min/day) across consecutive days', () => {
  // The synodic day is ~24h50m, so successive moonrises land ~24h + lag apart.
  // The lag itself (the day-over-day drift) is the quantity of interest; it
  // varies with the Moon's orbital speed (perigee/apogee) and declination,
  // empirically ~25–80 min for this window.
  const start = new Date('2026-06-10T12:00:00Z');
  const rises: Date[] = [];
  for (let d = 0; d < 8; d++) {
    const day = new Date(start.getTime() + d * 86400000);
    const r = moonInfo(NYC.lat, NYC.lng, day).rise;
    if (r) rises.push(r);
  }
  assert.ok(rises.length >= 4, `expected ≥4 consecutive moonrises, got ${rises.length}`);

  let checked = 0;
  for (let i = 1; i < rises.length; i++) {
    // Absolute gap between successive daily rises ≈ one day + lag. Subtract a
    // full day to isolate the lag (the wrap-around amount past 24h).
    const gapMin = (rises[i].getTime() - rises[i - 1].getTime()) / 60000;
    const lagMin = gapMin - 1440;
    assert.ok(
      lagMin >= 25 && lagMin <= 80,
      `daily moonrise lag ${lagMin.toFixed(1)} min out of [25,80] band`,
    );
    checked++;
  }
  assert.ok(checked >= 3, `expected ≥3 in-band daily deltas, checked ${checked}`);
});

test('rise/set azimuths are in [0,360); rise eastern, set western (mid-lat)', () => {
  // Average over several days to wash out the per-day declination wobble.
  let riseEastern = 0;
  let setWestern = 0;
  let riseSamples = 0;
  let setSamples = 0;
  for (let d = 0; d < 14; d++) {
    const day = new Date('2026-06-01T12:00:00Z'.replace('06-01', `06-${String(d + 1).padStart(2, '0')}`));
    const info = moonInfo(NYC.lat, NYC.lng, day);
    if (info.riseAz !== null) {
      assert.ok(info.riseAz >= 0 && info.riseAz < 360, `riseAz ${info.riseAz} out of range`);
      if (info.riseAz < 180) riseEastern++;
      riseSamples++;
    }
    if (info.setAz !== null) {
      assert.ok(info.setAz >= 0 && info.setAz < 360, `setAz ${info.setAz} out of range`);
      if (info.setAz > 180) setWestern++;
      setSamples++;
    }
  }
  // Generally (most days) rise is on the eastern half, set on the western half.
  assert.ok(
    riseEastern > riseSamples / 2,
    `expected most rises eastern, got ${riseEastern}/${riseSamples}`,
  );
  assert.ok(
    setWestern > setSamples / 2,
    `expected most sets western, got ${setWestern}/${setSamples}`,
  );
});

test('a day with no rise (or no set) returns null for that field without throwing', () => {
  // Roughly every ~29 days the moon skips a rise or a set on a given calendar
  // day (because of the ~50-min daily lag). Scan a month and assert we hit at
  // least one null of each kind, and that every call returns a valid shape.
  let nullRise = 0;
  let nullSet = 0;
  for (let d = 0; d < 31; d++) {
    const day = new Date(2026, 5, d + 1, 12, 0, 0); // local June 2026
    const info: MoonInfo = moonInfo(NYC.lat, NYC.lng, day);
    assert.ok(info.rise === null || info.rise instanceof Date);
    assert.ok(info.set === null || info.set instanceof Date);
    // Field consistency: az is null iff the corresponding event is null.
    assert.equal(info.rise === null, info.riseAz === null);
    assert.equal(info.set === null, info.setAz === null);
    if (info.rise === null) nullRise++;
    if (info.set === null) nullSet++;
  }
  assert.ok(nullRise >= 1, 'expected at least one calendar day with no moonrise in the month');
  assert.ok(nullSet >= 1, 'expected at least one calendar day with no moonset in the month');
});

test('illumination is always within [0,1] and phaseName is a known label', () => {
  const labels = new Set([
    'new',
    'waxing crescent',
    'first quarter',
    'waxing gibbous',
    'full',
    'waning gibbous',
    'last quarter',
    'waning crescent',
  ]);
  for (let d = 0; d < 30; d++) {
    const day = new Date(NEW_MOON_DATE.getTime() + d * 86400000);
    const info = moonInfo(NYC.lat, NYC.lng, day);
    assert.ok(info.illumination >= 0 && info.illumination <= 1);
    assert.ok(labels.has(info.phaseName), `unknown phase "${info.phaseName}"`);
  }
});
