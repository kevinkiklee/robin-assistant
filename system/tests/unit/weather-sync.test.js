import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import {
  buildEventFromForecast,
  parseLocation,
  wmoLabel,
} from '../../io/integrations/weather/client.js';
import { sync } from '../../io/integrations/weather/sync.js';

const fakeForecast = {
  daily: {
    time: ['2026-05-10'],
    temperature_2m_max: [72],
    temperature_2m_min: [54],
    weather_code: [1],
    precipitation_probability_max: [10],
    sunrise: ['2026-05-10T05:42'],
    sunset: ['2026-05-10T19:58'],
  },
  hourly: {
    time: ['2026-05-10T00:00', '2026-05-10T12:00', '2026-05-11T00:00'],
    temperature_2m: [55, 70, 56],
    precipitation_probability: [0, 5, 10],
    weather_code: [1, 1, 2],
  },
};

test('parseLocation accepts "lat,lon,name"', () => {
  const r = parseLocation('40.7128,-74.0060,NYC');
  assert.equal(r.name, 'NYC');
  assert.equal(r.lat, 40.7128);
  assert.equal(r.lon, -74.006);
});

test('parseLocation falls back to NYC default for empty input', () => {
  const r = parseLocation('');
  assert.equal(r.lat, 40.7128);
  assert.equal(r.lon, -74.006);
});

test('wmoLabel maps known codes', () => {
  assert.equal(wmoLabel(0), 'Clear');
  assert.equal(wmoLabel(95), 'Thunderstorm');
  assert.match(wmoLabel(123), /Code 123/);
});

test('buildEventFromForecast shapes content + meta', () => {
  const e = buildEventFromForecast(fakeForecast, { lat: 40.7128, lon: -74.006, name: 'NYC' });
  assert.equal(e.source, 'weather');
  assert.equal(e.external_id, 'weather:2026-05-10');
  assert.match(e.content, /NYC/);
  assert.match(e.content, /72°F \/ 54°F/);
  assert.match(e.content, /Mostly clear/);
  assert.equal(e.meta.location_name, 'NYC');
  assert.equal(e.meta.today.high, 72);
  assert.equal(e.meta.hourly.length, 2); // only hours on 2026-05-10
});

test('weather sync captures one event per day', async () => {
  const fetchFn = mock.fn(async () => ({ ok: true, json: async () => fakeForecast }));
  const captured = [];
  const r = await sync({
    secrets: {},
    log: () => {},
    cursor: null,
    capture: async (rows) => {
      captured.push(...rows);
      return {};
    },
    fetchFn,
  });
  assert.equal(r.count, 1);
  assert.equal(captured.length, 1);
  assert.match(captured[0].external_id, /^weather:\d{4}-\d{2}-\d{2}$/);
  assert.match(r.cursor.last_run_at, /^\d{4}-\d{2}-\d{2}T/);
});
