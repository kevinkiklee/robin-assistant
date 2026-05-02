#!/usr/bin/env node
// Template — auto-copied to user-data/ops/scripts/ by scaffold-sync.
// Imports resolve only after copy; not runnable in place.
//
// Calendar sync — fetches events from Google Calendar across the next 90 days
// and the past 90 days, writes scannable upcoming.md/recent.md tables, and
// lazily writes per-event detail files for events with attendees, descriptions,
// or meeting links.
//
// Usage:
//   node user-data/ops/scripts/sync-calendar.js              # incremental
//   node user-data/ops/scripts/sync-calendar.js --bootstrap  # full window pull
//   node user-data/ops/scripts/sync-calendar.js --dry-run    # no writes
//
// Requires: GOOGLE_OAUTH_REFRESH_TOKEN/CLIENT_ID/CLIENT_SECRET in .env
// (run auth-google.js first).

import { join } from 'node:path';
import { hostname } from 'node:os';
import { fileURLToPath } from 'node:url';
import { getAccessToken } from '../../../system/scripts/sync/lib/oauth.js';
import { loadCursor, saveCursor } from '../../../system/scripts/sync/lib/cursor.js';
import { atomicWrite, writeTable, openItem } from '../../../system/scripts/sync/lib/markdown.js';
import { updateIndex } from '../../../system/scripts/sync/lib/index-updater.js';
import { acquireLock, releaseLock } from '../../../system/scripts/jobs/lib/atomic.js';
import { buildEntityRegistry } from '../../../system/scripts/wiki-graph/lib/build-entity-registry.js';
import { applyEntityLinks } from '../../../system/scripts/wiki-graph/lib/apply-entity-links.js';
import { CalendarClient } from './lib/google/calendar-client.js';

const SOURCE = 'sync-calendar';
const PROVIDER = 'google';
const WINDOW_DAYS = 90;

// Insert wiki-graph entity links into a memory file we just wrote.
// Best-effort; never throw to the caller.
async function linkAfterWrite(workspaceDir, registry, wsRelPath) {
  if (!registry || !wsRelPath.startsWith('user-data/memory/')) return;
  const memRelPath = wsRelPath.slice('user-data/memory/'.length);
  try {
    await applyEntityLinks(workspaceDir, memRelPath, registry);
  } catch (err) {
    console.warn(`sync-calendar: applyEntityLinks(${memRelPath}) failed: ${err.message}`);
  }
}

function nowISO() { return new Date().toISOString(); }
function daysFromNow(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString();
}

function eventStart(ev) {
  return ev.start?.dateTime ?? ev.start?.date ?? '';
}
function eventEnd(ev) {
  return ev.end?.dateTime ?? ev.end?.date ?? '';
}
function eventTitle(ev) {
  return ev.summary || '(no title)';
}
function attendeeCount(ev) {
  return Array.isArray(ev.attendees) ? ev.attendees.length : 0;
}
function meetingUrl(ev) {
  return ev.hangoutLink || ev.conferenceData?.entryPoints?.find((e) => e.entryPointType === 'video')?.uri || '';
}

function eventRow(ev) {
  const start = eventStart(ev);
  const date = start.slice(0, 10);
  const time = start.length > 10 ? start.slice(11, 16) : '(all-day)';
  return {
    date,
    time,
    title: eventTitle(ev),
    location: ev.location ?? '',
    attendees: String(attendeeCount(ev)),
    has_meeting: meetingUrl(ev) ? 'yes' : '',
    calendar: ev._calendarId ?? 'primary',
  };
}

function isInteresting(ev) {
  return attendeeCount(ev) > 0 || !!ev.description || !!meetingUrl(ev);
}

function eventDetailMarkdown(ev) {
  const fm = [
    '---',
    `summary: ${JSON.stringify(eventTitle(ev))}`,
    `start: ${eventStart(ev)}`,
    `end: ${eventEnd(ev)}`,
    `location: ${JSON.stringify(ev.location ?? '')}`,
    `meeting_url: ${meetingUrl(ev)}`,
    `organizer: ${ev.organizer?.email ?? ''}`,
    `status: ${ev.status ?? ''}`,
    `attendees: ${attendeeCount(ev)}`,
    `description: Calendar event ${eventTitle(ev)} on ${eventStart(ev).slice(0, 10)}`,
    '---',
    '',
    `# ${eventTitle(ev)}`,
    '',
  ];
  if (ev.description) {
    fm.push(ev.description, '');
  }
  if (Array.isArray(ev.attendees) && ev.attendees.length > 0) {
    fm.push('## Attendees', '');
    for (const a of ev.attendees) {
      fm.push(`- ${a.email}${a.responseStatus ? ` (${a.responseStatus})` : ''}`);
    }
    fm.push('');
  }
  if (meetingUrl(ev)) {
    fm.push(`Meeting: ${meetingUrl(ev)}`, '');
  }
  return fm.join('\n');
}

export async function syncCalendar({ workspaceDir, dryRun = false, bootstrap = false }) {
  let registry = null;
  try {
    registry = await buildEntityRegistry(workspaceDir);
  } catch (err) {
    console.warn(`sync-calendar: registry unavailable, skipping link insertion (${err.message})`);
  }

  const accessToken = await getAccessToken(workspaceDir, PROVIDER);
  const client = new CalendarClient(accessToken);

  const calendars = await client.listCalendars();
  const ids = calendars.map((c) => c.id).filter(Boolean);
  console.log(`[sync-calendar] ${ids.length} calendars`);

  const timeMin = daysFromNow(-WINDOW_DAYS);
  const timeMax = daysFromNow(+WINDOW_DAYS);

  const all = [];
  for (const id of ids) {
    const { events } = await client.listEvents(id, { timeMin, timeMax });
    for (const e of events) {
      e._calendarId = id;
      all.push(e);
    }
  }
  console.log(`[sync-calendar] ${all.length} events across ${ids.length} calendars`);

  if (dryRun) {
    console.log('[sync-calendar] dry-run: skipping writes');
    return { calendars: ids.length, events: all.length };
  }

  // Sort, partition into upcoming/recent
  all.sort((a, b) => eventStart(a).localeCompare(eventStart(b)));
  const todayISO = new Date().toISOString().slice(0, 10);
  const upcoming = all.filter((e) => eventStart(e).slice(0, 10) >= todayISO);
  const recent = all.filter((e) => eventStart(e).slice(0, 10) < todayISO);

  const cols = ['date', 'time', 'title', 'location', 'attendees', 'has_meeting', 'calendar'];

  await atomicWrite(workspaceDir, 'user-data/memory/knowledge/calendar/upcoming.md',
    `---\ndescription: Calendar — next ${WINDOW_DAYS} days (auto-pulled)\n---\n\n# Upcoming Events\n\n` +
    `Pulled ${nowISO()}. ${upcoming.length} events in window [${timeMin.slice(0, 10)} → ${timeMax.slice(0, 10)}].\n\n` +
    writeTable({ columns: cols, rows: upcoming.map(eventRow) }),
    { trust: 'untrusted', trustSource: 'sync-calendar' }
  );
  await linkAfterWrite(workspaceDir, registry, 'user-data/memory/knowledge/calendar/upcoming.md');
  await atomicWrite(workspaceDir, 'user-data/memory/knowledge/calendar/recent.md',
    `---\ndescription: Calendar — last ${WINDOW_DAYS} days (auto-pulled)\n---\n\n# Recent Events\n\n` +
    `Pulled ${nowISO()}. ${recent.length} events.\n\n` +
    writeTable({ columns: cols, rows: recent.map(eventRow) }),
    { trust: 'untrusted', trustSource: 'sync-calendar' }
  );
  await linkAfterWrite(workspaceDir, registry, 'user-data/memory/knowledge/calendar/recent.md');

  // Lazy per-event files for "interesting" events (have attendees / description / meeting URL).
  let interestingCount = 0;
  for (const ev of all) {
    if (!isInteresting(ev)) continue;
    interestingCount += 1;
    const path = `user-data/memory/knowledge/calendar/events/${ev.id}.md`;
    await openItem(workspaceDir, path, async () => eventDetailMarkdown(ev));
    await linkAfterWrite(workspaceDir, registry, path);
  }

  saveCursor(workspaceDir, SOURCE, {
    last_attempt_at: nowISO(),
    last_success_at: nowISO(),
    error_count: 0,
    last_error: null,
    auth_status: 'ok',
    cursor: {
      window_days: WINDOW_DAYS,
      events_seen: all.length,
      interesting_events: interestingCount,
    },
  });

  await updateIndex(workspaceDir, { skipIfLocked: true });
  console.log(`[sync-calendar] wrote upcoming (${upcoming.length}) + recent (${recent.length}) + ${interestingCount} lazy event files`);
  return { calendars: ids.length, events: all.length, interesting: interestingCount };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const workspaceDir = fileURLToPath(new URL('../..', import.meta.url));
  const dryRun = process.argv.includes('--dry-run');
  const bootstrap = process.argv.includes('--bootstrap');

  const underRunner = !!process.env.ROBIN_WORKSPACE;
  const lockPath = join(workspaceDir, `user-data/ops/state/jobs/locks/${SOURCE}.lock`);
  let acquired = false;

  async function run() {
    if (!underRunner) {
      const r = acquireLock(lockPath, { host: hostname() });
      if (r === 'held') {
        console.log(`[${SOURCE}] another instance is running (lock held); exiting.`);
        return;
      }
      acquired = true;
    }
    try {
      await syncCalendar({ workspaceDir, dryRun, bootstrap });
    } finally {
      if (acquired) releaseLock(lockPath);
    }
  }

  run().catch((err) => {
    try {
      saveCursor(workspaceDir, SOURCE, {
        last_attempt_at: nowISO(),
        last_error: err.message,
        error_count: (loadCursor(workspaceDir, SOURCE).error_count ?? 0) + 1,
        auth_status: err.name === 'AuthError' ? 'needs_reauth' : 'unknown',
      });
    } catch { /* ignore */ }
    if (acquired) {
      try { releaseLock(lockPath); } catch { /* ignore */ }
    }
    console.error(`[${SOURCE}] failed: ${err.message}`);
    process.exit(1);
  });
}
