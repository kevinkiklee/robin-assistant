import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { closeDb, openDb } from '../../../brain/memory/db.ts';
import { allMigrations, applyMigrations } from '../../../brain/memory/migrations/index.ts';
import { buildContext } from '../../_runtime/context.ts';
import { integration as weather } from './index.ts';

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'robin-weather-'));
  mkdirSync(join(dir, 'state', 'db'), { recursive: true });
  const db = openDb(join(dir, 'state', 'db', 'robin.sqlite'));
  applyMigrations(db, allMigrations);
  return db;
}

test('weather: tick parses response and ingests an event', async () => {
  const db = freshDb();
  const ctx = buildContext('weather', db, null);
  // Mock the fetch with a stub that returns canned data
  const originalFetch = ctx.fetch;
  ctx.fetch = (async (_url: string) => {
    return new Response(
      JSON.stringify({
        current_condition: [{ temp_F: '72', weatherDesc: [{ value: 'Partly cloudy' }] }],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as typeof fetch;
  assert.ok(weather.tick);
  const r = await weather.tick(ctx);
  ctx.fetch = originalFetch;
  assert.equal(r.status, 'ok');
  assert.equal(r.ingested, 1);
  const row = db
    .prepare(`SELECT body FROM events_content WHERE body LIKE '%Partly cloudy%'`)
    .get() as {
    body: string;
  };
  assert.match(row.body, /72/);
  assert.equal(ctx.state.get('location'), null); // default 'New+York' used internally
  assert.ok(ctx.state.get('last_sync'));
  closeDb(db);
});

test('weather: tick handles non-OK fetch gracefully', async () => {
  const db = freshDb();
  const ctx = buildContext('weather', db, null);
  ctx.fetch = (async () => new Response('boom', { status: 502 })) as typeof fetch;
  assert.ok(weather.tick);
  const r = await weather.tick(ctx);
  assert.equal(r.status, 'error');
  assert.ok(r.message);
  assert.match(r.message, /502/);
  closeDb(db);
});

test('weather: tick adds sun-time fields when nearest_area lat/long present', async () => {
  const db = freshDb();
  const ctx = buildContext('weather', db, null);
  ctx.fetch = (async () =>
    new Response(
      JSON.stringify({
        current_condition: [{ temp_F: '68', weatherDesc: [{ value: 'Clear' }] }],
        nearest_area: [{ latitude: '40.7128', longitude: '-74.0060' }],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )) as typeof fetch;
  assert.ok(weather.tick);
  const r = await weather.tick(ctx);
  assert.equal(r.status, 'ok');
  const row = db
    .prepare(`SELECT payload FROM events WHERE source = 'weather' ORDER BY id DESC LIMIT 1`)
    .get() as { payload: string };
  const payload = JSON.parse(row.payload) as {
    sunrise?: string;
    sunset?: string;
    golden_hour_evening_start?: string;
  };
  assert.ok(payload.sunrise, 'expected non-empty sunrise');
  assert.ok(payload.sunset, 'expected non-empty sunset');
  assert.ok(payload.golden_hour_evening_start, 'expected non-empty golden_hour_evening_start');
  assert.match(payload.sunrise as string, /^\d{4}-\d{2}-\d{2}T/);
  closeDb(db);
});

test('weather: tick omits sun fields (null) when nearest_area absent', async () => {
  const db = freshDb();
  const ctx = buildContext('weather', db, null);
  ctx.fetch = (async () =>
    new Response(
      JSON.stringify({
        current_condition: [{ temp_F: '55', weatherDesc: [{ value: 'Overcast' }] }],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )) as typeof fetch;
  assert.ok(weather.tick);
  const r = await weather.tick(ctx);
  assert.equal(r.status, 'ok');
  const row = db
    .prepare(`SELECT payload FROM events WHERE source = 'weather' ORDER BY id DESC LIMIT 1`)
    .get() as { payload: string };
  const payload = JSON.parse(row.payload) as { sunrise?: string | null };
  assert.equal(payload.sunrise ?? null, null);
  closeDb(db);
});

test('weather: tick computes fog_nights from the hourly forecast', async () => {
  const db = freshDb();
  const ctx = buildContext('weather', db, null);
  const slot = (time: string) => ({
    time,
    tempF: '62',
    DewPointF: '61',
    humidity: '97',
    windspeedMiles: '2',
    chanceoffog: '70',
  });
  ctx.fetch = (async () =>
    new Response(
      JSON.stringify({
        current_condition: [{ temp_F: '64', weatherDesc: [{ value: 'Mist' }] }],
        weather: [
          { date: '2026-06-10', hourly: [slot('2100')] },
          { date: '2026-06-11', hourly: [slot('0'), slot('300'), slot('600')] },
        ],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )) as typeof fetch;
  assert.ok(weather.tick);
  const r = await weather.tick(ctx);
  assert.equal(r.status, 'ok');
  const row = db
    .prepare(`SELECT body, payload FROM events e JOIN events_content c ON c.id = e.content_ref
              WHERE e.source = 'weather' ORDER BY e.id DESC LIMIT 1`)
    .get() as { body: string; payload: string };
  const payload = JSON.parse(row.payload) as {
    fog_nights?: Array<{ date: string; index: number; band: string }>;
  };
  assert.ok(payload.fog_nights && payload.fog_nights.length > 0, 'fog_nights present');
  assert.equal(payload.fog_nights[0].date, '2026-06-10');
  assert.ok(
    payload.fog_nights[0].index >= 6,
    `expected high index, got ${payload.fog_nights[0].index}`,
  );
  assert.match(row.body, /fog tonight \d+\/10/);
  closeDb(db);
});

test('weather: state KV persists last_sync between ticks', async () => {
  const db = freshDb();
  const ctx = buildContext('weather', db, null);
  ctx.fetch = (async () =>
    new Response(
      JSON.stringify({
        current_condition: [{ temp_F: '60', weatherDesc: [{ value: 'Sunny' }] }],
      }),
      { status: 200 },
    )) as typeof fetch;
  assert.ok(weather.tick);
  await weather.tick(ctx);
  const first = ctx.state.get('last_sync');
  assert.ok(first);
  closeDb(db);
});
