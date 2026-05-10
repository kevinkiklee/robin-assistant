// eBird API 2.0 client. Auth via X-eBirdApiToken header.
// https://documenter.getpostman.com/view/664302/S1ENwy59

export async function listRecentObservations({
  apiKey,
  locationId,
  back = 14,
  maxResults = 100,
  fetchFn = globalThis.fetch,
  signal,
}) {
  const params = new URLSearchParams({
    back: String(back),
    maxResults: String(maxResults),
    sppLocale: 'en',
  });
  const url = `https://api.ebird.org/v2/data/obs/${encodeURIComponent(locationId)}/recent?${params}`;
  const r = await fetchFn(url, {
    headers: { 'X-eBirdApiToken': apiKey, Accept: 'application/json' },
    signal,
  });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error(`ebird recent failed: ${r.status} ${body.slice(0, 200)}`);
  }
  return await r.json();
}

export function buildEventFromObservation(obs, locationId) {
  const obsId = obs.subId ?? `${obs.speciesCode}-${obs.obsDt}`;
  const species = obs.comName ?? obs.sciName ?? obs.speciesCode ?? '(unknown)';
  const locName = obs.locName ?? locationId;
  const obsDate = obs.obsDt ?? '';
  return {
    source: 'ebird',
    content: `${species} at ${locName} · ${obsDate}`,
    ts: obsDate ? new Date(obsDate.replace(' ', 'T')) : new Date(),
    external_id: `ebird:${obsId}`,
    meta: {
      obs_id: obsId,
      species: obs.speciesCode ?? null,
      common_name: obs.comName ?? null,
      scientific_name: obs.sciName ?? null,
      count: typeof obs.howMany === 'number' ? obs.howMany : null,
      location_id: obs.locId ?? locationId,
      location_name: locName,
      obs_date: obsDate,
      lat: typeof obs.lat === 'number' ? obs.lat : null,
      lon: typeof obs.lng === 'number' ? obs.lng : null,
    },
  };
}
