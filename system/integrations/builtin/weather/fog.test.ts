import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fogNights, type OmHourly, wmoText } from './fog.ts';

// Build a 2-day hourly series; saturate the night of 2026-06-25.
function series(): OmHourly {
  const time: string[] = [];
  const at = (d: string, h: number) => `${d}T${String(h).padStart(2, '0')}:00`;
  for (const d of ['2026-06-25', '2026-06-26']) for (let h = 0; h < 24; h++) time.push(at(d, h));
  const n = time.length;
  const fill = (v: number) => Array(n).fill(v);
  const h: OmHourly = {
    time,
    temperature_2m: fill(60),
    dew_point_2m: fill(59),
    relative_humidity_2m: fill(96),
    wind_speed_10m: fill(3),
    weather_code: fill(2),
    visibility: fill(20000),
  };
  return h;
}

test('fogNights: saturated calm night ⇒ high index, likely band', () => {
  const nights = fogNights(series(), '2026-06-25');
  const tonight = nights.find((x) => x.date === '2026-06-25');
  assert.ok(tonight);
  // spread=1°F / RH=96 / wind=3 → composite ≈9.3, rounds to index 9
  assert.ok((tonight as { index: number }).index >= 8, `index ${tonight?.index}`);
});

test('fogNights: dry windy clear night ⇒ unlikely band', () => {
  // Build a series identical to series() but with dry/windy/clear conditions.
  const time: string[] = [];
  const at = (d: string, h: number) => `${d}T${String(h).padStart(2, '0')}:00`;
  for (const d of ['2026-06-25', '2026-06-26']) for (let h = 0; h < 24; h++) time.push(at(d, h));
  const n = time.length;
  const fill = (v: number) => Array(n).fill(v);
  const dryHourly: OmHourly = {
    time,
    temperature_2m: fill(70),
    dew_point_2m: fill(40),
    relative_humidity_2m: fill(40),
    wind_speed_10m: fill(20),
    weather_code: fill(2),
    visibility: fill(20000),
  };
  const nights = fogNights(dryHourly, '2026-06-25');
  const tonight = nights.find((x) => x.date === '2026-06-25');
  assert.ok(tonight, 'night entry should exist');
  assert.equal(tonight!.band, 'unlikely', `band was ${tonight!.band}`);
});

test('fogNights: night with <2 scorable slots is skipped', () => {
  // Only provide T21:00 of 2026-06-25; none of 2026-06-26's 00/03/06 slots.
  const time = ['2026-06-25T21:00'];
  const fill = (v: number) => Array(1).fill(v);
  const sparse: OmHourly = {
    time,
    temperature_2m: fill(60),
    dew_point_2m: fill(59),
    relative_humidity_2m: fill(96),
    wind_speed_10m: fill(3),
    weather_code: fill(2),
    visibility: fill(20000),
  };
  const nights = fogNights(sparse, '2026-06-25');
  const tonight = nights.find((x) => x.date === '2026-06-25');
  assert.equal(tonight, undefined, 'sparse night should be skipped');
});

test('wmoText maps codes', () => {
  assert.equal(wmoText(0), 'clear');
  assert.equal(wmoText(45), 'fog');
  assert.equal(wmoText(3), 'overcast');
});
