import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildEventFromCalendarItem,
  getEvent,
  listEvents,
} from '../../io/integrations/google_calendar/client.js';

test('buildEventFromCalendarItem: timed event with attendees', () => {
  const item = {
    id: 'evt-1',
    summary: 'Standup',
    status: 'confirmed',
    start: { dateTime: '2026-05-09T10:00:00Z' },
    end: { dateTime: '2026-05-09T10:30:00Z' },
    attendees: [{ email: 'a@example.com' }, { email: 'b@example.com' }],
    organizer: { email: 'a@example.com' },
    location: 'Zoom',
    htmlLink: 'https://calendar.google.com/...',
    etag: 'W/"abc"',
  };
  const e = buildEventFromCalendarItem(item);
  assert.equal(e.source, 'google_calendar');
  assert.equal(e.external_id, 'evt-1');
  assert.match(e.content, /^Standup · 2026-05-09T10:00:00Z – 2026-05-09T10:30:00Z · 2 attendees$/);
  assert.equal(e.ts.toISOString(), '2026-05-09T10:00:00.000Z');
  assert.equal(e.meta.event_id, 'evt-1');
  assert.equal(e.meta.calendar_id, 'primary');
  assert.equal(e.meta.status, 'confirmed');
  assert.equal(e.meta.organizer_email, 'a@example.com');
  assert.deepEqual(e.meta.attendees, ['a@example.com', 'b@example.com']);
  assert.equal(e.meta.location, 'Zoom');
  assert.equal(e.meta.html_link, 'https://calendar.google.com/...');
  assert.equal(e.meta.etag, 'W/"abc"');
});

test('buildEventFromCalendarItem: cancelled prefix', () => {
  const item = {
    id: 'evt-2',
    summary: 'Coffee',
    status: 'cancelled',
    start: { dateTime: '2026-05-10T09:00:00Z' },
    end: { dateTime: '2026-05-10T09:30:00Z' },
  };
  const e = buildEventFromCalendarItem(item);
  assert.match(e.content, /^\[CANCELLED\] Coffee · /);
  assert.equal(e.meta.status, 'cancelled');
});

test('buildEventFromCalendarItem: all-day event (date, not dateTime)', () => {
  const item = {
    id: 'evt-3',
    summary: 'Birthday',
    status: 'confirmed',
    start: { date: '2026-05-09' },
    end: { date: '2026-05-10' },
  };
  const e = buildEventFromCalendarItem(item);
  assert.match(e.content, /^Birthday · 2026-05-09 – 2026-05-10 · 0 attendees$/);
  // start is parsed as midnight UTC
  assert.equal(e.ts.toISOString(), '2026-05-09T00:00:00.000Z');
});

test('buildEventFromCalendarItem: missing summary falls back to (no title)', () => {
  const item = {
    id: 'evt-4',
    status: 'confirmed',
    start: { dateTime: '2026-05-09T12:00:00Z' },
    end: { dateTime: '2026-05-09T13:00:00Z' },
  };
  const e = buildEventFromCalendarItem(item);
  assert.match(e.content, /^\(no title\) · /);
});

test('buildEventFromCalendarItem: no start/end gracefully uses updated or now', () => {
  const item = {
    id: 'evt-5',
    summary: 'X',
    status: 'confirmed',
    updated: '2026-05-09T08:00:00Z',
  };
  const e = buildEventFromCalendarItem(item);
  assert.equal(e.ts.toISOString(), '2026-05-09T08:00:00.000Z');
});

test('listEvents: passes timeMin/timeMax + singleEvents + maxResults', async () => {
  let calledUrl = null;
  let calledInit = null;
  const fakeFetch = async (url, init) => {
    calledUrl = url;
    calledInit = init;
    return { ok: true, json: async () => ({ items: [], nextPageToken: null }) };
  };
  const result = await listEvents({
    accessToken: 'tok-abc',
    timeMin: '2026-05-09T00:00:00Z',
    timeMax: '2026-05-10T00:00:00Z',
    fetchFn: fakeFetch,
  });
  assert.deepEqual(result, { items: [], nextPageToken: null });
  assert.ok(calledUrl.startsWith('https://www.googleapis.com/calendar/v3/calendars/primary/events?'));
  assert.match(calledUrl, /timeMin=2026-05-09T00%3A00%3A00Z/);
  assert.match(calledUrl, /timeMax=2026-05-10T00%3A00%3A00Z/);
  assert.match(calledUrl, /singleEvents=true/);
  assert.match(calledUrl, /maxResults=250/);
  assert.equal(calledInit.headers.Authorization, 'Bearer tok-abc');
});

test('listEvents: optional updatedMin + pageToken', async () => {
  let calledUrl = null;
  const fakeFetch = async (url) => {
    calledUrl = url;
    return { ok: true, json: async () => ({}) };
  };
  await listEvents({
    accessToken: 't',
    timeMin: 'a',
    timeMax: 'b',
    updatedMin: '2026-05-08T00:00:00Z',
    pageToken: 'PT',
    fetchFn: fakeFetch,
  });
  assert.match(calledUrl, /updatedMin=2026-05-08T00%3A00%3A00Z/);
  assert.match(calledUrl, /pageToken=PT/);
});

test('listEvents: non-2xx throws with status code', async () => {
  const fakeFetch = async () => ({ ok: false, status: 503, json: async () => ({}) });
  await assert.rejects(
    () => listEvents({ accessToken: 't', timeMin: 'a', timeMax: 'b', fetchFn: fakeFetch }),
    /calendar .* 503/,
  );
});

test('getEvent: URL-encodes eventId + sends bearer token', async () => {
  let calledUrl = null;
  let calledInit = null;
  const fakeFetch = async (url, init) => {
    calledUrl = url;
    calledInit = init;
    return { ok: true, json: async () => ({ id: 'weird/id', summary: 'x' }) };
  };
  const r = await getEvent({ accessToken: 'tk', eventId: 'weird/id', fetchFn: fakeFetch });
  assert.equal(calledUrl, 'https://www.googleapis.com/calendar/v3/calendars/primary/events/weird%2Fid');
  assert.equal(calledInit.headers.Authorization, 'Bearer tk');
  assert.equal(r.id, 'weird/id');
});
