async function calendarFetch(path, { accessToken, fetchFn = globalThis.fetch, signal }) {
  const r = await fetchFn(`https://www.googleapis.com/calendar/v3${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal,
  });
  if (!r.ok) throw new Error(`calendar ${path} ${r.status}`);
  return await r.json();
}

export async function listEvents({
  accessToken,
  timeMin,
  timeMax,
  updatedMin,
  pageToken,
  fetchFn,
  signal,
}) {
  const params = new URLSearchParams({
    timeMin,
    timeMax,
    singleEvents: 'true',
    maxResults: '250',
  });
  if (updatedMin) params.set('updatedMin', updatedMin);
  if (pageToken) params.set('pageToken', pageToken);
  return await calendarFetch(`/calendars/primary/events?${params}`, {
    accessToken,
    fetchFn,
    signal,
  });
}

export async function getEvent({ accessToken, eventId, fetchFn, signal }) {
  return await calendarFetch(`/calendars/primary/events/${encodeURIComponent(eventId)}`, {
    accessToken,
    fetchFn,
    signal,
  });
}

export function buildEventFromCalendarItem(item) {
  const startIso = item.start?.dateTime ?? item.start?.date ?? '';
  const endIso = item.end?.dateTime ?? item.end?.date ?? '';
  const attendeeCount = (item.attendees ?? []).length;
  const summary = item.summary ?? '(no title)';
  const cancelled = item.status === 'cancelled';
  const content = cancelled
    ? `[CANCELLED] ${summary} · ${startIso} – ${endIso} · ${attendeeCount} attendees`
    : `${summary} · ${startIso} – ${endIso} · ${attendeeCount} attendees`;
  return {
    source: 'google_calendar',
    content,
    ts: new Date(startIso || item.updated || Date.now()),
    external_id: item.id,
    meta: {
      event_id: item.id,
      calendar_id: 'primary',
      status: item.status,
      organizer_email: item.organizer?.email,
      attendees: (item.attendees ?? []).map((a) => a.email),
      location: item.location,
      html_link: item.htmlLink,
      etag: item.etag,
    },
  };
}
