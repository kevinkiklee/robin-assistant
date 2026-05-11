const BASE = 'https://analyticsdata.googleapis.com/v1beta';

export async function runReport({
  accessToken,
  propertyId,
  startDate,
  endDate,
  fetchFn = globalThis.fetch,
  signal,
}) {
  const r = await fetchFn(`${BASE}/properties/${propertyId}:runReport`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      dateRanges: [{ startDate, endDate }],
      dimensions: [{ name: 'date' }],
      metrics: [
        { name: 'totalUsers' },
        { name: 'newUsers' },
        { name: 'sessions' },
        { name: 'screenPageViews' },
        { name: 'bounceRate' },
        { name: 'averageSessionDuration' },
      ],
    }),
    signal,
  });
  if (!r.ok) {
    const errBody = await r.text().catch(() => '');
    const err = new Error(`ga ${r.status}: ${errBody}`);
    err.status = r.status;
    err.body = errBody;
    throw err;
  }
  return await r.json();
}

export function isScopeError(err) {
  if (err?.status !== 403) return false;
  const body = err.body ?? '';
  return /PERMISSION_DENIED|ACCESS_TOKEN_SCOPE_INSUFFICIENT|scope/i.test(body);
}

export function buildEventFromGaRow(row, propertyId) {
  const date = row.dimensionValues?.[0]?.value;
  const m = row.metricValues ?? [];
  const users = Number.parseInt(m[0]?.value ?? '0', 10);
  const newUsers = Number.parseInt(m[1]?.value ?? '0', 10);
  const sessions = Number.parseInt(m[2]?.value ?? '0', 10);
  const pageviews = Number.parseInt(m[3]?.value ?? '0', 10);
  const bounceRate = Number.parseFloat(m[4]?.value ?? '0');
  const avgDuration = Number.parseFloat(m[5]?.value ?? '0');
  // GA4 returns date as 'YYYYMMDD'; normalize to ISO date.
  const isoDate = date ? `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}` : null;
  return {
    source: 'ga',
    content: `GA4 ${propertyId} · ${isoDate} · ${users} users · ${sessions} sessions · ${pageviews} pageviews`,
    ts: isoDate ? new Date(isoDate) : new Date(),
    external_id: `ga:${propertyId}:${isoDate}`,
    meta: {
      property_id: propertyId,
      date: isoDate,
      users,
      new_users: newUsers,
      sessions,
      pageviews,
      bounce_rate: bounceRate,
      avg_session_duration: avgDuration,
    },
  };
}
