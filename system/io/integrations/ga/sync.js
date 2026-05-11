import { getSecret } from '../../../config/secrets.js';
import { getAccessToken } from '../_auth/token-cache.js';
import { buildEventFromGaRow, isScopeError, runReport } from './client.js';

const ROLLING_DAYS = 30;

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function rollingStart(savedDate) {
  const minus30 = new Date(Date.now() - ROLLING_DAYS * 86400_000).toISOString().slice(0, 10);
  if (!savedDate) return minus30;
  return savedDate < minus30 ? minus30 : savedDate;
}

export async function sync(ctx) {
  const propsRaw = getSecret('GA_PROPERTIES');
  if (!propsRaw) {
    throw new Error('GA_PROPERTIES env var required (comma-separated property IDs)');
  }
  const properties = propsRaw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (properties.length === 0) {
    throw new Error('GA_PROPERTIES is empty');
  }

  const accessToken = await getAccessToken({
    provider: 'google',
    secrets: ctx.secrets,
    fetchFn: ctx.fetchFn,
    saveSecret: ctx.saveSecret,
  });
  const today = todayStr();
  const startDate = rollingStart(ctx.cursor?.last_date ?? null);
  const allEvents = [];
  for (const propertyId of properties) {
    try {
      const report = await runReport({
        accessToken,
        propertyId,
        startDate,
        endDate: today,
        fetchFn: ctx.fetchFn,
        signal: ctx.signal,
      });
      for (const row of report.rows ?? []) {
        allEvents.push(buildEventFromGaRow(row, propertyId));
      }
    } catch (e) {
      if (isScopeError(e)) {
        ctx.log('GA4 requires analytics.readonly scope. Re-auth: robin auth google --code');
        throw e;
      }
      throw e;
    }
  }
  await ctx.capture(allEvents);
  return { count: allEvents.length, cursor: { last_date: today } };
}
