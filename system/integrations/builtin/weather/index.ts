import { solarTimes } from '../../../lib/solar.ts';
import type { Integration } from '../../_runtime/types.ts';
import { fogNights, type WttrDay } from './fog.ts';

export const integration: Integration = {
  async tick(ctx) {
    const location = ctx.state.get('location') ?? 'New+York';
    const res = await ctx.fetch(`https://wttr.in/${location}?format=j1`);
    if (!res.ok) {
      return { status: 'error', message: `wttr.in returned ${res.status}` };
    }
    const data = (await res.json()) as {
      current_condition?: Array<{ temp_F?: string; weatherDesc?: Array<{ value: string }> }>;
      nearest_area?: Array<{ latitude?: string; longitude?: string }>;
      weather?: WttrDay[];
    };
    const cond = data.current_condition?.[0];
    // Night fog outlooks from the same response's 3-day hourly forecast,
    // date-keyed so a renderer can pick "tonight" even from a stale event.
    const fog = fogNights(data.weather ?? []);
    const fogNote = fog.length > 0 ? ` · fog tonight ${fog[0].index}/10 (${fog[0].band})` : '';
    const summary = `Weather (${location}): ${cond?.temp_F ?? '?'}°F, ${cond?.weatherDesc?.[0]?.value ?? 'unknown'}${fogNote}`;

    // Derive sun/light windows from the response's nearest_area lat/long. wttr.in
    // returns these as strings; if absent or non-finite, the sun fields stay null.
    const lat = Number(data.nearest_area?.[0]?.latitude);
    const lng = Number(data.nearest_area?.[0]?.longitude);
    let sun: {
      sunrise: string | null;
      sunset: string | null;
      golden_hour_morning_end: string | null;
      golden_hour_evening_start: string | null;
      blue_hour_morning_start: string | null;
      blue_hour_evening_end: string | null;
    } = {
      sunrise: null,
      sunset: null,
      golden_hour_morning_end: null,
      golden_hour_evening_start: null,
      blue_hour_morning_start: null,
      blue_hour_evening_end: null,
    };
    if (Number.isFinite(lat) && Number.isFinite(lng)) {
      const s = solarTimes(lat, lng, ctx.now());
      sun = {
        sunrise: s.sunrise?.toISOString() ?? null,
        sunset: s.sunset?.toISOString() ?? null,
        golden_hour_morning_end: s.goldenHourMorningEnd?.toISOString() ?? null,
        golden_hour_evening_start: s.goldenHourEveningStart?.toISOString() ?? null,
        blue_hour_morning_start: s.blueHourMorningStart?.toISOString() ?? null,
        blue_hour_evening_end: s.blueHourEveningEnd?.toISOString() ?? null,
      };
    }

    await ctx.ingest({
      kind: 'integration.tick',
      source: 'weather',
      content: summary,
      payload: {
        kind: 'current',
        location,
        temp_f: cond?.temp_F,
        desc: cond?.weatherDesc?.[0]?.value,
        fog_nights: fog,
        ...sun,
      },
    });
    ctx.state.set('last_sync', ctx.now().toISOString());
    return { status: 'ok', ingested: 1 };
  },
  async health(ctx) {
    const last = ctx.state.get('last_sync');
    return { ok: true, message: last ? `last sync: ${last}` : 'never synced' };
  },
};
