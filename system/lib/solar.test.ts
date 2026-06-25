import assert from 'node:assert/strict';
import { test } from 'node:test';
import { solarTimes, sunBearings } from './solar.ts';

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

const ASTORIA = { lat: 40.764, lng: -73.923 };

test('sunBearings: summer solstice ENE sunrise / WNW sunset from Astoria', () => {
  const b = sunBearings(ASTORIA.lat, ASTORIA.lng, new Date('2026-06-21T12:00:00Z'));
  assert.ok(b.sunriseAz !== null && b.sunsetAz !== null);
  assert.ok(Math.abs((b.sunriseAz as number) - 58) < 4, `sunrise ${b.sunriseAz}`); // ~58° ENE
  assert.ok(Math.abs((b.sunsetAz as number) - 302) < 4, `sunset ${b.sunsetAz}`); // ~302° WNW
});

test('sunBearings: equinox ⇒ ~due-east sunrise, ~due-west sunset', () => {
  const b = sunBearings(ASTORIA.lat, ASTORIA.lng, new Date('2026-03-20T12:00:00Z'));
  assert.ok(Math.abs((b.sunriseAz as number) - 90) < 3);
  assert.ok(Math.abs((b.sunsetAz as number) - 270) < 3);
});
