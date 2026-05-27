import { ingest } from '../../../brain/memory/ingest.ts';
import { getGoogleAccessToken } from '../../_auth/oauth-google.ts';
import type { Integration, IntegrationContext } from '../../_runtime/types.ts';

const API_BASE = 'https://www.googleapis.com/calendar/v3';

export interface CalendarEvent {
  id: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: { dateTime?: string; date?: string; timeZone?: string };
  end?: { dateTime?: string; date?: string; timeZone?: string };
  attendees?: Array<{ email: string; displayName?: string; responseStatus?: string }>;
  htmlLink?: string;
  updated?: string;
  status?: string;
}

interface EventsListResponse {
  items?: CalendarEvent[];
  nextPageToken?: string;
}

async function calGet<T>(ctx: IntegrationContext, path: string, token: string): Promise<T> {
  const res = await ctx.fetch(`${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`calendar ${path} returned ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

function formatEventTime(e: CalendarEvent): string {
  const s = e.start?.dateTime ?? e.start?.date ?? '?';
  const t = e.end?.dateTime ?? e.end?.date ?? '?';
  return `${s} → ${t}`;
}

export const integration: Integration = {
  async tick(ctx) {
    let token: string;
    try {
      token = await getGoogleAccessToken(ctx, 'GOOGLE_CALENDAR');
    } catch (err) {
      return { status: 'skipped', message: err instanceof Error ? err.message : String(err) };
    }

    const now = ctx.now();
    const in7 = new Date(now.getTime() + 7 * 24 * 3600 * 1000);
    const calendarId = ctx.state.get('calendar_id') ?? 'primary';
    const params = new URLSearchParams({
      timeMin: now.toISOString(),
      timeMax: in7.toISOString(),
      singleEvents: 'true',
      orderBy: 'startTime',
      maxResults: '50',
    });
    const list = await calGet<EventsListResponse>(
      ctx,
      `/calendars/${encodeURIComponent(calendarId)}/events?${params}`,
      token,
    );
    const events = list.items ?? [];

    let ingested = 0;
    // Dedup cache is self-managed state; a corrupt value should reset + warn,
    // never throw and wedge the tick.
    let seenIds: string[] = [];
    try {
      seenIds = JSON.parse(ctx.state.get('seen_event_ids') ?? '[]');
    } catch {
      ctx.log.warn({ key: 'seen_event_ids' }, 'corrupt dedup state; resetting to empty');
    }
    const seen = new Set(seenIds);
    const totalEvents = events.length;
    let eventIndex = 0;
    for (const ev of events) {
      const key = `${ev.id}:${ev.updated ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      eventIndex++;
      const attendeeNames = (ev.attendees ?? []).map((a) => a.displayName ?? a.email).join(', ');
      const title = ev.summary ?? '(no title)';
      const when = formatEventTime(ev);
      const summary =
        `[calendar] ${title}\n  When: ${when}` +
        (ev.location ? `\n  Where: ${ev.location}` : '') +
        (attendeeNames ? `\n  With: ${attendeeNames}` : '') +
        (totalEvents > 1 ? `\n  Day context: event ${eventIndex} of ${totalEvents} today` : '') +
        (ev.description ? `\n\n${ev.description.slice(0, 500)}` : '');
      const dayContext =
        totalEvents > 1 ? { meetingIndex: eventIndex, totalToday: totalEvents } : null;
      await ingest(ctx.db, ctx.llm, {
        kind: 'integration.google_calendar.event',
        source: 'google_calendar',
        content: summary,
        payload: {
          id: ev.id,
          summary: ev.summary,
          start: ev.start?.dateTime ?? ev.start?.date,
          end: ev.end?.dateTime ?? ev.end?.date,
          location: ev.location,
          attendees: ev.attendees?.length ?? 0,
          status: ev.status,
          dayContext,
        },
      });
      ingested++;
    }
    const seenArr = Array.from(seen).slice(-300);
    ctx.state.set('seen_event_ids', JSON.stringify(seenArr));
    ctx.state.set('last_sync', ctx.now().toISOString());
    return { status: 'ok', ingested };
  },

  async health(ctx) {
    const last = ctx.state.get('last_sync');
    if (!process.env.GOOGLE_CALENDAR_REFRESH_TOKEN) {
      return { ok: false, message: 'GOOGLE_CALENDAR_REFRESH_TOKEN not set' };
    }
    return { ok: true, message: last ? `last sync: ${last}` : 'never synced' };
  },
};

export const actions = {
  async list_events(
    params: { timeMin?: string; timeMax?: string; calendarId?: string; maxResults?: number },
    ctx: IntegrationContext,
  ): Promise<CalendarEvent[]> {
    const token = await getGoogleAccessToken(ctx, 'GOOGLE_CALENDAR');
    const calendarId = params.calendarId ?? 'primary';
    const now = ctx.now();
    const qs = new URLSearchParams({
      timeMin: params.timeMin ?? now.toISOString(),
      timeMax: params.timeMax ?? new Date(now.getTime() + 7 * 86400_000).toISOString(),
      singleEvents: 'true',
      orderBy: 'startTime',
      maxResults: String(params.maxResults ?? 50),
    });
    const r = await calGet<EventsListResponse>(
      ctx,
      `/calendars/${encodeURIComponent(calendarId)}/events?${qs}`,
      token,
    );
    return r.items ?? [];
  },
  async get_event(
    params: { eventId: string; calendarId?: string },
    ctx: IntegrationContext,
  ): Promise<CalendarEvent> {
    const token = await getGoogleAccessToken(ctx, 'GOOGLE_CALENDAR');
    const calendarId = params.calendarId ?? 'primary';
    return calGet<CalendarEvent>(
      ctx,
      `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(params.eventId)}`,
      token,
    );
  },
};
