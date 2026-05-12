// v1 was sunset in late 2025. v2 keeps the same base host and path shape
// (/recovery, /activity/sleep, /activity/workout, /cycle), but sleep and
// workout resources now use UUID ids rather than numeric ones. Our
// external_id keys treat ids as opaque strings, so the id-shape change
// flows through transparently.
const WHOOP_BASE = 'https://api.prod.whoop.com/developer/v2';
const DEFAULT_WINDOW_DAYS = 14;
const DAY_MS = 86_400_000;

async function whoopFetch(path, { accessToken, fetchFn = globalThis.fetch, signal }) {
  const r = await fetchFn(`${WHOOP_BASE}${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal,
  });
  if (!r.ok) throw new Error(`whoop ${path} ${r.status}`);
  return await r.json();
}

function buildParams({ since, nextToken }) {
  const params = new URLSearchParams();
  if (since) params.set('start', since);
  else params.set('start', new Date(Date.now() - DEFAULT_WINDOW_DAYS * DAY_MS).toISOString());
  if (nextToken) params.set('nextToken', nextToken);
  return params;
}

export async function listRecovery({ accessToken, since, nextToken, fetchFn, signal }) {
  return await whoopFetch(`/recovery?${buildParams({ since, nextToken })}`, {
    accessToken,
    fetchFn,
    signal,
  });
}

export async function listSleep({ accessToken, since, nextToken, fetchFn, signal }) {
  return await whoopFetch(`/activity/sleep?${buildParams({ since, nextToken })}`, {
    accessToken,
    fetchFn,
    signal,
  });
}

export async function listWorkouts({ accessToken, since, nextToken, fetchFn, signal }) {
  return await whoopFetch(`/activity/workout?${buildParams({ since, nextToken })}`, {
    accessToken,
    fetchFn,
    signal,
  });
}

export async function listCycles({ accessToken, since, nextToken, fetchFn, signal }) {
  return await whoopFetch(`/cycle?${buildParams({ since, nextToken })}`, {
    accessToken,
    fetchFn,
    signal,
  });
}

function fmt(n) {
  return n == null ? '?' : String(n);
}

export function buildEventFromRecovery(rec) {
  const score = rec.score ?? {};
  const externalId = `whoop:recovery:${rec.cycle_id ?? rec.sleep_id ?? rec.id}`;
  return {
    source: 'whoop',
    content: `recovery: ${fmt(score.recovery_score)}% · HRV ${fmt(score.hrv_rmssd_milli)}ms · RHR ${fmt(score.resting_heart_rate)}`,
    ts: new Date(rec.created_at ?? rec.updated_at ?? Date.now()),
    external_id: externalId,
    meta: { kind: 'recovery', ...rec },
  };
}

export function buildEventFromSleep(s) {
  const totalMs = s.score?.stage_summary?.total_in_bed_time_milli ?? 0;
  const hours = Math.floor(totalMs / 3_600_000);
  const minutes = Math.floor((totalMs % 3_600_000) / 60_000);
  return {
    source: 'whoop',
    content: `sleep: ${hours}h ${minutes}m · efficiency ${fmt(s.score?.sleep_efficiency_percentage)}%`,
    ts: new Date(s.start ?? s.created_at ?? Date.now()),
    external_id: `whoop:sleep:${s.id}`,
    meta: { kind: 'sleep', ...s },
  };
}

export function buildEventFromWorkout(w) {
  const startMs = new Date(w.start ?? Date.now()).getTime();
  const endMs = w.end ? new Date(w.end).getTime() : startMs;
  const minutes = Math.max(0, Math.round((endMs - startMs) / 60_000));
  return {
    source: 'whoop',
    content: `workout: ${fmt(w.sport_id)} · ${minutes}min · strain ${fmt(w.score?.strain)}`,
    ts: new Date(w.start ?? Date.now()),
    external_id: `whoop:workout:${w.id}`,
    meta: { kind: 'workout', ...w },
  };
}

export function buildEventFromCycle(c) {
  const startMs = new Date(c.start ?? Date.now()).getTime();
  const endMs = c.end ? new Date(c.end).getTime() : Date.now();
  const hours = Math.max(0, Math.round((endMs - startMs) / 3_600_000));
  return {
    source: 'whoop',
    content: `cycle: ${hours}h · day_strain ${fmt(c.score?.strain)}`,
    ts: new Date(c.start ?? Date.now()),
    external_id: `whoop:cycle:${c.id}`,
    meta: { kind: 'cycle', ...c },
  };
}
