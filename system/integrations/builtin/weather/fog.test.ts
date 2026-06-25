import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fogNights, wmoText, type OmHourly } from './fog.ts';

// Build a 2-day hourly series; saturate the night of 2026-06-25.
function series(): OmHourly {
  const time: string[] = [];
  const at = (d: string, h: number) => `${d}T${String(h).padStart(2, '0')}:00`;
  for (const d of ['2026-06-25', '2026-06-26']) for (let h = 0; h < 24; h++) time.push(at(d, h));
  const n = time.length;
  const fill = (v: number) => Array(n).fill(v);
  const h: OmHourly = {
    time, temperature_2m: fill(60), dew_point_2m: fill(59), relative_humidity_2m: fill(96),
    wind_speed_10m: fill(3), weather_code: fill(2), visibility: fill(20000),
  };
  return h;
}

test('fogNights: saturated calm night ⇒ high index, likely band', () => {
  const nights = fogNights(series(), '2026-06-25');
  const tonight = nights.find((x) => x.date === '2026-06-25');
  assert.ok(tonight);
  assert.ok((tonight as { index: number }).index >= 6, `index ${tonight?.index}`);
});

test('wmoText maps codes', () => {
  assert.equal(wmoText(0), 'clear');
  assert.equal(wmoText(45), 'fog');
  assert.equal(wmoText(3), 'overcast');
});
