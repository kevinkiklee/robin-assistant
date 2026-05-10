import { getGoogleAccessToken } from '../_auth/token-cache.js';
import { buildEventFromCalendarItem, listEvents } from './client.js';

const WINDOW_DAYS = 14;
const DAY_MS = 86_400_000;

export async function sync(ctx) {
  const accessToken = await getGoogleAccessToken({
    secrets: ctx.secrets,
    fetchFn: ctx.fetchFn,
  });
  const now = new Date();
  const timeMin = new Date(now.getTime() - WINDOW_DAYS * DAY_MS).toISOString();
  const timeMax = new Date(now.getTime() + WINDOW_DAYS * DAY_MS).toISOString();
  const updatedMin = ctx.cursor?.updated_min;

  const events = [];
  let pageToken = null;
  do {
    const page = await listEvents({
      accessToken,
      timeMin,
      timeMax,
      updatedMin,
      pageToken,
      fetchFn: ctx.fetchFn,
      signal: ctx.signal,
    });
    pageToken = page.nextPageToken;
    for (const item of page.items ?? []) {
      events.push(buildEventFromCalendarItem(item));
    }
  } while (pageToken);

  await ctx.capture(events);
  return { count: events.length, cursor: { updated_min: new Date().toISOString() } };
}
