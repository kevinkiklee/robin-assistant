import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { closeDb, openDb } from '../../../brain/memory/db.ts';
import { allMigrations, applyMigrations } from '../../../brain/memory/migrations/index.ts';
import { buildContext } from '../../_runtime/context.ts';
import { actions, integration as cal } from './index.ts';

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
      return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), {
        status: 200,
      });
    }
    if (url.includes('/calendars/primary/events')) {
      return new Response(
        JSON.stringify({
          items: [
            {
              id: 'evt1',
              summary: 'Lunch with Nora',
              updated: '2026-05-19T08:00:00Z',
              start: { dateTime: '2026-05-19T12:00:00Z' },
              end: { dateTime: '2026-05-19T13:00:00Z' },
              location: 'Restaurant',
              attendees: [{ email: 'nora@example.com', displayName: 'Nora' }],
            },
            {
              id: 'evt2',
              summary: 'Team standup',
              updated: '2026-05-19T07:00:00Z',
              start: { dateTime: '2026-05-19T15:00:00Z' },
              end: { dateTime: '2026-05-19T15:30:00Z' },
            },
          ],
        }),
        { status: 200 },
      );
    }
    return new Response('', { status: 404 });
  }) as typeof fetch;

  const r = await cal.tick!(ctx);
  assert.equal(r.status, 'ok');
  assert.equal(r.ingested, 2);
  const rows = db
    .prepare("SELECT body FROM events_content WHERE body LIKE '%Lunch with Nora%'")
    .all();
  assert.equal(rows.length, 1);

  // Second tick dedupes
  const r2 = await cal.tick!(ctx);
  assert.equal(r2.ingested, 0);
  clearEnv();
  closeDb(db);
});

test('google_calendar: tick tolerates corrupt dedup state (resets, does not throw)', async () => {
  const db = freshDb();
  const ctx = buildContext('google_calendar', db, null);
  setEnv();
  ctx.state.set('seen_event_ids', '{not valid json'); // simulate on-disk corruption
  ctx.fetch = (async (url: string) => {
    if (url.includes('oauth2.googleapis.com/token')) {
      return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), {
        status: 200,
      });
    }
    if (url.includes('/calendars/primary/events')) {
      return new Response(JSON.stringify({ items: [{ id: 'evt1', summary: 'Solo event' }] }), {
        status: 200,
      });
    }
    return new Response('', { status: 404 });
  }) as typeof fetch;
  const r = await cal.tick!(ctx);
  assert.equal(r.status, 'ok'); // corrupt cache treated as empty, not a crash
  assert.equal(r.ingested, 1);
  clearEnv();
  closeDb(db);
});

test('google_calendar: requests showDeleted and ingests cancellations with status', async () => {
  const db = freshDb();
  const ctx = buildContext('google_calendar', db, null);
  setEnv();
  let eventsUrl = '';
  ctx.fetch = (async (url: string) => {
    if (url.includes('oauth2.googleapis.com/token')) {
      return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), {
        status: 200,
      });
    }
    if (url.includes('/calendars/primary/events')) {
      eventsUrl = url;
      return new Response(
        JSON.stringify({
          items: [
            {
              id: 'live1',
              summary: 'Still on',
              status: 'confirmed',
              updated: '2026-05-19T08:00:00Z',
              start: { dateTime: '2026-05-19T12:00:00Z' },
              end: { dateTime: '2026-05-19T13:00:00Z' },
            },
            // Cancellation stub, as the API returns it: no summary, no start.
            { id: 'gone1', status: 'cancelled', updated: '2026-05-19T09:00:00Z' },
          ],
        }),
        { status: 200 },
      );
    }
    return new Response('', { status: 404 });
  }) as typeof fetch;

  const r = await cal.tick!(ctx);
  assert.equal(r.status, 'ok');
  assert.equal(r.ingested, 2);
  assert.ok(eventsUrl.includes('showDeleted=true'), 'tick fetch carries showDeleted');
  const rows = db
    .prepare("SELECT payload FROM events WHERE kind = 'integration.google_calendar.event'")
    .all() as Array<{ payload: string }>;
  const statuses = rows.map((row) => (JSON.parse(row.payload) as { status?: string }).status);
  assert.ok(statuses.includes('cancelled'), 'cancellation row carries status');
  const bodies = db.prepare("SELECT body FROM events_content WHERE body LIKE '%CANCELLED%'").all();
  assert.equal(bodies.length, 1, 'cancellation content is marked CANCELLED');
  clearEnv();
  closeDb(db);
});

test('google_calendar: actions.list_events returns event array', async () => {
  const db = freshDb();
  const ctx = buildContext('google_calendar', db, null);
  setEnv();
  ctx.fetch = (async (url: string) => {
    if (url.includes('oauth2.googleapis.com/token')) {
      return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), {
        status: 200,
      });
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
