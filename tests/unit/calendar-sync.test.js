import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { _resetCache } from '../../src/integrations/_auth/google-token-cache.js';
import { sync } from '../../src/integrations/google_calendar/sync.js';

function fakeEvent(id, opts = {}) {
  return {
    id,
    summary: opts.summary ?? `Event ${id}`,
    status: opts.status ?? 'confirmed',
    start: { dateTime: '2026-05-09T10:00:00Z' },
    end: { dateTime: '2026-05-09T11:00:00Z' },
    attendees: opts.attendees ?? [],
    organizer: { email: 'me@me.com' },
    htmlLink: `https://calendar.google.com/${id}`,
    etag: 'abc',
    updated: opts.updated ?? '2026-05-09T09:00:00Z',
  };
}

test('first sync captures events and saves cursor', async () => {
  _resetCache();
  const fetchFn = mock.fn(async (url) => {
    if (url.includes('/token'))
      return { ok: true, json: async () => ({ access_token: 'a', expires_in: 3600 }) };
    if (url.includes('/calendars'))
      return {
        ok: true,
        json: async () => ({ items: [fakeEvent('e1'), fakeEvent('e2')] }),
      };
    throw new Error(`unexpected: ${url}`);
  });
  const captured = [];
  const ctx = {
    secrets: {
      GOOGLE_OAUTH_REFRESH_TOKEN: 'r',
      GOOGLE_OAUTH_CLIENT_ID: 'c',
      GOOGLE_OAUTH_CLIENT_SECRET: 's',
    },
    log: () => {},
    cursor: null,
    capture: async (rows) => {
      captured.push(...rows);
      return {};
    },
    fetchFn,
  };
  const r = await sync(ctx);
  assert.equal(r.count, 2);
  assert.ok(r.cursor.updated_min);
  assert.equal(captured[0].external_id, 'e1');
});

test('cancelled events get [CANCELLED] prefix', async () => {
  _resetCache();
  const fetchFn = mock.fn(async (url) => {
    if (url.includes('/token'))
      return { ok: true, json: async () => ({ access_token: 'a', expires_in: 3600 }) };
    if (url.includes('/calendars'))
      return {
        ok: true,
        json: async () => ({
          items: [fakeEvent('e1', { status: 'cancelled', summary: 'Old Meeting' })],
        }),
      };
    throw new Error(`unexpected: ${url}`);
  });
  const captured = [];
  const ctx = {
    secrets: {
      GOOGLE_OAUTH_REFRESH_TOKEN: 'r',
      GOOGLE_OAUTH_CLIENT_ID: 'c',
      GOOGLE_OAUTH_CLIENT_SECRET: 's',
    },
    log: () => {},
    cursor: null,
    capture: async (rows) => {
      captured.push(...rows);
      return {};
    },
    fetchFn,
  };
  await sync(ctx);
  assert.match(captured[0].content, /\[CANCELLED\]/);
});

test('delta sync passes updatedMin', async () => {
  _resetCache();
  let updatedMinSeen = null;
  const fetchFn = mock.fn(async (url) => {
    if (url.includes('/token'))
      return { ok: true, json: async () => ({ access_token: 'a', expires_in: 3600 }) };
    if (url.includes('/calendars')) {
      const u = new URL(url);
      updatedMinSeen = u.searchParams.get('updatedMin');
      return { ok: true, json: async () => ({ items: [] }) };
    }
    throw new Error(`unexpected: ${url}`);
  });
  const ctx = {
    secrets: {
      GOOGLE_OAUTH_REFRESH_TOKEN: 'r',
      GOOGLE_OAUTH_CLIENT_ID: 'c',
      GOOGLE_OAUTH_CLIENT_SECRET: 's',
    },
    log: () => {},
    cursor: { updated_min: '2026-05-08T00:00:00Z' },
    capture: async () => ({}),
    fetchFn,
  };
  await sync(ctx);
  assert.equal(updatedMinSeen, '2026-05-08T00:00:00Z');
});
