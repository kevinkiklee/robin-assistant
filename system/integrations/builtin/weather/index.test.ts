import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { closeDb, openDb } from '../../../brain/memory/db.ts';
import { allMigrations, applyMigrations } from '../../../brain/memory/migrations/index.ts';
import fixture from './fixtures/open-meteo.json' with { type: 'json' };
import { integration } from './index.ts';

/** Map-backed KvStore + capturing ctx that returns the Open-Meteo fixture. */
function makeCtx(captured: { payload?: any; content?: string }, db?: any) {
  const kv = new Map<string, string>();
  return {
    state: {
      get: (k: string) => kv.get(k) ?? null,
      set: (k: string, v: string) => void kv.set(k, v),
      delete: (k: string) => void kv.delete(k),
    },
    fetch: (async () => ({ ok: true, status: 200, json: async () => fixture })) as any,
    now: () => new Date('2026-06-25T20:00:00-04:00'),
    ingest: async (input: any) => {
      captured.payload = input.payload;
      captured.content = input.content;
      return {};
    },
    // Harmless DB stub by default — alert-store calls go through prepare().
    db: (db ?? {
      prepare: () => ({
        get: () => undefined,
        run: () => ({ changes: 0, lastInsertRowid: 1 }),
        all: () => [],
      }),
    }) as any,
    log: { info() {}, warn() {}, error() {} },
    llm: null,
    checkOutbound: () => ({ allow: true }) as any,
  } as any;
}

test('weather: tick ingests an enriched weather.current payload with sky reads', async () => {
  const cap: { payload?: any; content?: string } = {};
  const ctx = makeCtx(cap);
  const r = await integration.tick!(ctx);

  assert.equal(r.status, 'ok');
  assert.ok(cap.payload, 'payload captured');
  assert.equal(cap.payload.kind, 'current');
  // Enriched scalar fields.
  assert.ok(typeof cap.payload.temp_f !== 'undefined', 'temp_f defined');
  assert.ok(typeof cap.payload.wind_mph !== 'undefined', 'wind_mph defined');
  assert.ok(typeof cap.payload.cloud_cover !== 'undefined', 'cloud_cover defined');
  assert.ok(typeof cap.payload.desc === 'string', 'desc is a string');
  assert.ok(Array.isArray(cap.payload.fog_nights), 'fog_nights array');
  // Sun windows still present.
  assert.ok('sunrise' in cap.payload && 'sunset' in cap.payload, 'sun windows present');
  // Sky block.
  assert.ok(cap.payload.sky, 'sky block present');
  assert.ok('asOf' in cap.payload.sky, 'sky.asOf present');
  assert.ok('sunrise' in cap.payload.sky, 'sky.sunrise key present');
  assert.ok('sunset' in cap.payload.sky, 'sky.sunset key present');
  // At 8pm the same-day sunset window is still ahead → a ColorRead, not null.
  assert.ok(cap.payload.sky.sunset, 'sunset ColorRead computed');
  assert.equal(cap.payload.sky.sunset.window, 'sunset');
  assert.ok(typeof cap.payload.sky.sunset.band === 'string', 'sunset band');
});

test('weather: tick degrades to base payload when sky_context is off', async () => {
  const cap: { payload?: any } = {};
  const ctx = makeCtx(cap);
  ctx.state.set('sky_context', 'off');
  const r = await integration.tick!(ctx);

  assert.equal(r.status, 'ok');
  assert.ok(typeof cap.payload.temp_f !== 'undefined', 'temp_f still ingested');
  assert.ok(Array.isArray(cap.payload.fog_nights), 'fog_nights still ingested');
  assert.equal(cap.payload.sky.sunrise, null, 'sky reads null when disabled');
  assert.equal(cap.payload.sky.sunset, null, 'sky reads null when disabled');
});

test('weather: tick returns error on a non-OK fetch', async () => {
  const cap: { payload?: any } = {};
  const ctx = makeCtx(cap);
  ctx.fetch = (async () => ({ ok: false, status: 503, json: async () => ({}) })) as any;
  const r = await integration.tick!(ctx);
  assert.equal(r.status, 'error');
  assert.ok(r.message && /503/.test(r.message), 'message mentions status');
});

test('weather: tick + alerts run against a real DB schema without throwing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'robin-weather-'));
  mkdirSync(join(dir, 'state', 'db'), { recursive: true });
  const db = openDb(join(dir, 'state', 'db', 'robin.sqlite'));
  applyMigrations(db, allMigrations);

  const cap: { payload?: any } = {};
  const ctx = makeCtx(cap, db);
  const r = await integration.tick!(ctx);

  assert.equal(r.status, 'ok');
  assert.ok(cap.payload.sky, 'sky block present with real DB');
  closeDb(db);
});
