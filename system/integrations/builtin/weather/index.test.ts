import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDb, closeDb } from '../../../brain/memory/db.ts';
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
  const r = await weather.tick!(ctx);
  ctx.fetch = originalFetch;
  assert.equal(r.status, 'ok');
  assert.equal(r.ingested, 1);
  const row = db.prepare(`SELECT body FROM events_content WHERE body LIKE '%Partly cloudy%'`).get() as {
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
  const r = await weather.tick!(ctx);
  assert.equal(r.status, 'error');
  assert.match(r.message!, /502/);
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
  await weather.tick!(ctx);
  const first = ctx.state.get('last_sync');
  assert.ok(first);
  closeDb(db);
});
