import { buildEventFromForecast, fetchForecast, parseLocation } from './client.js';

export async function sync(ctx) {
  const location = parseLocation(process.env.WEATHER_LOCATION);
  const data = await fetchForecast({
    lat: location.lat,
    lon: location.lon,
    fetchFn: ctx.fetchFn,
    signal: ctx.signal,
  });
  const event = buildEventFromForecast(data, location);
  await ctx.capture([event]);
  return { count: 1, cursor: { last_run_at: new Date().toISOString() } };
}
