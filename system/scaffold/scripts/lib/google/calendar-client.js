// Template — auto-copied to user-data/scripts/lib/google/ by scaffold-sync.
// Imports resolve only after copy; not runnable in place.

import { fetchJson, AuthError } from '../../../../system/scripts/sync/lib/http.js';

export { AuthError };

const BASE = 'https://www.googleapis.com/calendar/v3';

export class CalendarClient {
  constructor(accessToken) {
    if (!accessToken) throw new Error('CalendarClient: access token required');
    this.token = accessToken;
  }

  headers() {
    return { Authorization: `Bearer ${this.token}` };
  }

  async listCalendars() {
    const data = await fetchJson(`${BASE}/users/me/calendarList`, { headers: this.headers() });
    return data.items ?? [];
  }

  // Fetch all events in [timeMin, timeMax] across pages. Returns the merged list.
  // Optionally pass syncToken for incremental sync (set timeMin/timeMax to undefined when using sync token).
  async listEvents(calendarId, { timeMin, timeMax, syncToken, pageSize = 250 } = {}) {
    const all = [];
    let pageToken;
    let nextSyncToken;
    do {
      const u = new URL(`${BASE}/calendars/${encodeURIComponent(calendarId)}/events`);
      if (syncToken) {
        u.searchParams.set('syncToken', syncToken);
      } else {
        if (timeMin) u.searchParams.set('timeMin', timeMin);
        if (timeMax) u.searchParams.set('timeMax', timeMax);
        u.searchParams.set('singleEvents', 'true');
        u.searchParams.set('orderBy', 'startTime');
      }
      u.searchParams.set('maxResults', String(pageSize));
      if (pageToken) u.searchParams.set('pageToken', pageToken);
      const data = await fetchJson(u.toString(), { headers: this.headers() });
      all.push(...(data.items ?? []));
      pageToken = data.nextPageToken;
      if (data.nextSyncToken) nextSyncToken = data.nextSyncToken;
    } while (pageToken);
    return { events: all, nextSyncToken };
  }
}
