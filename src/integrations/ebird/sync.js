import { buildEventFromObservation, listRecentObservations } from './client.js';

const DEFAULT_HOTSPOT = 'L191106'; // Central Park, NYC.

export async function sync(ctx) {
  const locationId = process.env.EBIRD_HOTSPOT || DEFAULT_HOTSPOT;
  const obs = await listRecentObservations({
    apiKey: ctx.secrets.EBIRD_API_KEY,
    locationId,
    back: 14,
    maxResults: 100,
    fetchFn: ctx.fetchFn,
    signal: ctx.signal,
  });
  const events = (Array.isArray(obs) ? obs : []).map((o) =>
    buildEventFromObservation(o, locationId),
  );
  await ctx.capture(events);
  return { count: events.length, cursor: { last_run_at: new Date().toISOString() } };
}
