import assert from 'node:assert/strict';
import { test } from 'node:test';
import { solarTimes } from './solar.ts';

test('solar: NYC summer solstice — sunrise early, sunset evening, ~15h day', () => {
  const t = solarTimes(40.7128, -74.006, new Date(Date.UTC(2026, 5, 21)));
  assert.ok(t.sunrise && t.sunset);
  const dayHours = (t.sunset!.getTime() - t.sunrise!.getTime()) / 3.6e6;
  assert.ok(dayHours > 14.5 && dayHours < 15.5, `day length ${dayHours}`);
});

test('solar: ordering invariants hold', () => {
  const t = solarTimes(40.7128, -74.006, new Date(Date.UTC(2026, 5, 21)));
  assert.ok(t.blueHourMorningStart! < t.sunrise!);
  assert.ok(t.sunrise! < t.goldenHourMorningEnd!);
  assert.ok(t.goldenHourMorningEnd! < t.goldenHourEveningStart!);
  assert.ok(t.goldenHourEveningStart! < t.sunset!);
  assert.ok(t.sunset! < t.blueHourEveningEnd!);
});
