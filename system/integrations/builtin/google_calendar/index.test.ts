import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDb, closeDb } from '../../../brain/memory/db.ts';
import { allMigrations, applyMigrations } from '../../../brain/memory/migrations/index.ts';
import { buildContext } from '../../_runtime/context.ts';
import { integration as cal, actions } from './index.ts';

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'robin-cal-'));
  mkdirSync(join(dir, 'state', 'db'), { recursive: true });
  const db = openDb(join(dir, 'state', 'db', 'robin.sqlite'));
  applyMigrations(db, allMigrations);
  return db;
}

function setEnv() {
  process.env.GOOGLE_CALENDAR_REFRESH_TOKEN = 'r';
  process.env.GOOGLE_CALENDAR_CLIENT_ID = 'c';
  process.env.GOOGLE_CALENDAR_CLIENT_SECRET = 's';
}
function clearEnv() {
  delete process.env.GOOGLE_CALENDAR_REFRESH_TOKEN;
  delete process.env.GOOGLE_CALENDAR_CLIENT_ID;
  delete process.env.GOOGLE_CALENDAR_CLIENT_SECRET;
}

test('google_calendar: tick skips when secrets missing', async () => {
  const db = freshDb();
  const ctx = buildContext('google_calendar', db, null);
  clearEnv();
  const r = await cal.tick!(ctx);
  assert.equal(r.status, 'skipped');
  closeDb(db);
});

test('google_calendar: tick fetches + ingests upcoming events', async () => {
  const db = freshDb();
  const ctx = buildContext('google_calendar', db, null);
  setEnv();
  ctx.fetch = (async (url: string) => {
    if (url.includes('oauth2.googleapis.com/token')) {
      return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), { status: 200 });
    }
    if (url.includes('/calendars/primary/events')) {
      return new Response(JSON.stringify({
        items: [
          {
            id: 'evt1', summary: 'Lunch with Sarah', updated: '2026-05-19T08:00:00Z',
            start: { dateTime: '2026-05-19T12:00:00Z' }, end: { dateTime: '2026-05-19T13:00:00Z' },
            location: 'Restaurant', attendees: [{ email: 'sarah@example.com', displayName: 'Sarah' }],
          },
          {
            id: 'evt2', summary: 'Team standup', updated: '2026-05-19T07:00:00Z',
            start: { dateTime: '2026-05-19T15:00:00Z' }, end: { dateTime: '2026-05-19T15:30:00Z' },
          },
        ],
      }), { status: 200 });
    }
    return new Response('', { status: 404 });
  }) as typeof fetch;

  const r = await cal.tick!(ctx);
  assert.equal(r.status, 'ok');
  assert.equal(r.ingested, 2);
  const rows = db.prepare("SELECT body FROM events_content WHERE body LIKE '%Lunch with Sarah%'").all();
  assert.equal(rows.length, 1);

  // Second tick dedupes
  const r2 = await cal.tick!(ctx);
  assert.equal(r2.ingested, 0);
  clearEnv();
  closeDb(db);
});

test('google_calendar: actions.list_events returns event array', async () => {
  const db = freshDb();
  const ctx = buildContext('google_calendar', db, null);
  setEnv();
  ctx.fetch = (async (url: string) => {
    if (url.includes('oauth2.googleapis.com/token')) {
      return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), { status: 200 });
    }
    return new Response(JSON.stringify({ items: [{ id: 'a', summary: 'X' }] }), { status: 200 });
  }) as typeof fetch;
  const r = await actions.list_events({}, ctx);
  assert.equal(r.length, 1);
  clearEnv();
  closeDb(db);
});

test('google_calendar: health is unhealthy without secrets', async () => {
  const db = freshDb();
  const ctx = buildContext('google_calendar', db, null);
  clearEnv();
  const h = await cal.health!(ctx);
  assert.equal(h.ok, false);
  closeDb(db);
});
