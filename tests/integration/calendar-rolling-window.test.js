import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { _resetCache } from '../../src/integrations/_auth/token-cache.js';
import { sync } from '../../src/integrations/google_calendar/sync.js';

function fakeEvent(id) {
  return {
    id,
    summary: `Event ${id}`,
    status: 'confirmed',
    start: { dateTime: '2026-05-09T10:00:00Z' },
    end: { dateTime: '2026-05-09T11:00:00Z' },
    attendees: [],
    organizer: { email: 'me@me.com' },
    htmlLink: `https://calendar.google.com/${id}`,
    etag: 'abc',
    updated: '2026-05-09T09:00:00Z',
  };
}

test('first sync without cursor, then delta with cursor', async () => {
  _resetCache();
  const calls = [];
  const fetchFn = mock.fn(async (url) => {
    calls.push(url);
    if (url.includes('/token')) {
      return { ok: true, json: async () => ({ access_token: 'a', expires_in: 3600 }) };
    }
    if (url.includes('/calendars')) {
      const u = new URL(url);
      const updatedMin = u.searchParams.get('updatedMin');
      // First sync: no updatedMin; return 2 events
      // Second sync: updatedMin set; return 1 event (a "delta")
      if (!updatedMin) {
        return { ok: true, json: async () => ({ items: [fakeEvent('e1'), fakeEvent('e2')] }) };
      }
      return { ok: true, json: async () => ({ items: [fakeEvent('e3')] }) };
    }
    throw new Error(`unexpected: ${url}`);
  });
  const captured = [];
  const ctx0 = {
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
  const r1 = await sync(ctx0);
  assert.equal(r1.count, 2);
  assert.ok(r1.cursor.updated_min);
  // Delta sync using saved cursor
  const ctx1 = { ...ctx0, cursor: r1.cursor };
  const r2 = await sync(ctx1);
  assert.equal(r2.count, 1);
  // Verify the second /calendars call had updatedMin set
  const calendarCalls = calls.filter((u) => u.includes('/calendars'));
  assert.equal(calendarCalls.length, 2);
  assert.ok(!new URL(calendarCalls[0]).searchParams.get('updatedMin'));
  assert.ok(new URL(calendarCalls[1]).searchParams.get('updatedMin'));
});
