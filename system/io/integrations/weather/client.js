// Open-Meteo client. No auth — public endpoint.
// https://api.open-meteo.com/v1/forecast

const WMO = {
  0: 'Clear',
  1: 'Mostly clear',
  2: 'Partly cloudy',
  3: 'Overcast',
  45: 'Fog',
  48: 'Rime fog',
  51: 'Light drizzle',
  53: 'Drizzle',
  55: 'Heavy drizzle',
  56: 'Freezing drizzle',
  57: 'Heavy freezing drizzle',
  61: 'Light rain',
  63: 'Rain',
  65: 'Heavy rain',
  66: 'Freezing rain',
  67: 'Heavy freezing rain',
  71: 'Light snow',
  73: 'Snow',
  75: 'Heavy snow',
  77: 'Snow grains',
  80: 'Light rain showers',
  81: 'Rain showers',
  82: 'Violent rain showers',
  85: 'Light snow showers',
  86: 'Heavy snow showers',
  95: 'Thunderstorm',
  96: 'Thunderstorm w/ light hail',
  99: 'Thunderstorm w/ heavy hail',
};

export function wmoLabel(code) {
  if (code === undefined || code === null) return 'Unknown';
  return WMO[code] ?? `Code ${code}`;
}

export function parseLocation(loc) {
  // "lat,lon" or "lat,lon,name". Defaults to NYC if not parseable.
  const parts = (loc ?? '').split(',').map((s) => s.trim());
  const lat = Number.parseFloat(parts[0]);
  const lon = Number.parseFloat(parts[1]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return { lat: 40.7128, lon: -74.006, name: 'New York, NY' };
  }
  return { lat, lon, name: parts[2] || `${lat.toFixed(4)},${lon.toFixed(4)}` };
}

function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  // HH:MM in UTC — caller decides how to display. Open-Meteo returns local
  // ISO strings (no Z) when timezone=auto, so slicing keeps that local time.
  return iso.slice(11, 16);
}

export async function fetchForecast({ lat, lon, fetchFn = globalThis.fetch, signal }) {
  const params = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    current: ['temperature_2m', 'weather_code', 'wind_speed_10m'].join(','),
    daily: [
      'weather_code',
      'temperature_2m_max',
      'temperature_2m_min',
      'precipitation_probability_max',
      'sunrise',
      'sunset',
    ].join(','),
    hourly: [
      'temperature_2m',
      'precipitation_probability',
      'weather_code',
      'wind_speed_10m',
      'wind_direction_10m',
    ].join(','),
    temperature_unit: 'fahrenheit',
    wind_speed_unit: 'mph',
    precipitation_unit: 'inch',
    timezone: 'auto',
    forecast_days: '2',
  });
  const r = await fetchFn(`https://api.open-meteo.com/v1/forecast?${params}`, { signal });
  if (!r.ok) throw new Error(`open-meteo forecast failed: ${r.status}`);
  return await r.json();
}

export function buildEventFromForecast(data, location) {
  const daily = data.daily ?? {};
  const at = (key) => (Array.isArray(daily[key]) ? daily[key][0] : undefined);
  const date = at('time') ?? new Date().toISOString().slice(0, 10);
  const high = at('temperature_2m_max');
  const low = at('temperature_2m_min');
  const code = at('weather_code');
  const conditions = wmoLabel(code);
  const sunrise = at('sunrise');
  const sunset = at('sunset');
  const sunriseTime = fmtTime(sunrise);
  const sunsetTime = fmtTime(sunset);

  // Approximate golden-hour windows: 30 minutes after sunrise / before sunset.
  // Cheap and good enough for downstream surfacing without re-implementing
  // Meeus solar position math here.
  const goldenHourStart = sunset
    ? new Date(new Date(sunset).getTime() - 30 * 60_000).toISOString()
    : null;
  const goldenHourEnd = sunrise
    ? new Date(new Date(sunrise).getTime() + 30 * 60_000).toISOString()
    : null;

  const today = {
    date,
    high,
    low,
    code,
    conditions,
    precip_probability: at('precipitation_probability_max'),
  };

  // Keep today + tomorrow's hourly rows. The overnight migration window
  // (sunset → next sunrise) crosses midnight, so trimming to today only
  // would drop the dawn hours that matter most. forecast_days=2 already
  // fetches both days; ~48 rows in meta is bounded fine.
  const h = data.hourly ?? {};
  const hourly = [];
  const times = h.time ?? [];
  const tomorrow = new Date(`${date}T00:00:00Z`);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  const tomorrowStr = tomorrow.toISOString().slice(0, 10);
  for (let i = 0; i < times.length; i++) {
    const t = times[i];
    if (!t) continue;
    const d = t.slice(0, 10);
    if (d !== date && d !== tomorrowStr) continue;
    hourly.push({
      time: t,
      temp: h.temperature_2m?.[i],
      precip_probability: h.precipitation_probability?.[i],
      code: h.weather_code?.[i],
      wind_speed_10m: h.wind_speed_10m?.[i],
      wind_direction_10m: h.wind_direction_10m?.[i],
    });
  }

  const highStr = high === undefined ? '—' : Math.round(high);
  const lowStr = low === undefined ? '—' : Math.round(low);
  const content = `${location.name} · ${highStr}°F / ${lowStr}°F · ${conditions} · sunrise ${sunriseTime} · sunset ${sunsetTime}`;

  return {
    source: 'weather',
    content,
    ts: new Date(`${date}T12:00:00Z`),
    external_id: `weather:${date}`,
    meta: {
      lat: location.lat,
      lon: location.lon,
      location_name: location.name,
      today,
      hourly,
      sunrise,
      sunset,
      golden_hour_start: goldenHourStart,
      golden_hour_end: goldenHourEnd,
    },
  };
}
