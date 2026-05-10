import { getAccessToken } from '../_auth/token-cache.js';
import {
  FIRST_SYNC_CAP,
  FIRST_SYNC_DAYS,
  buildEventFromFile,
  getStartPageToken,
  listChanges,
  listFiles,
} from './client.js';

async function firstSync(ctx, accessToken) {
  const cutoff = new Date(Date.now() - FIRST_SYNC_DAYS * 86400_000).toISOString();
  const events = [];
  let pageToken = null;
  let total = 0;
  do {
    const page = await listFiles({
      accessToken,
      q: `modifiedTime > '${cutoff}'`,
      pageToken,
      fetchFn: ctx.fetchFn,
      signal: ctx.signal,
    });
    pageToken = page.nextPageToken;
    for (const file of page.files ?? []) {
      if (total >= FIRST_SYNC_CAP) break;
      events.push(buildEventFromFile(file));
      total += 1;
    }
  } while (pageToken && total < FIRST_SYNC_CAP);
  await ctx.capture(events);
  const { startPageToken } = await getStartPageToken({
    accessToken,
    fetchFn: ctx.fetchFn,
    signal: ctx.signal,
  });
  return { count: events.length, cursor: { start_page_token: startPageToken } };
}

async function deltaSync(ctx, accessToken, startPageToken) {
  const events = [];
  let pageToken = startPageToken;
  let newStartPageToken = startPageToken;
  do {
    const page = await listChanges({
      accessToken,
      pageToken,
      fetchFn: ctx.fetchFn,
      signal: ctx.signal,
    });
    if (page.newStartPageToken) newStartPageToken = page.newStartPageToken;
    pageToken = page.nextPageToken;
    for (const change of page.changes ?? []) {
      if (change.removed || !change.file) continue;
      events.push(buildEventFromFile(change.file));
    }
  } while (pageToken);
  await ctx.capture(events);
  return { count: events.length, cursor: { start_page_token: newStartPageToken } };
}

export async function sync(ctx) {
  const accessToken = await getAccessToken({
    provider: 'google',
    secrets: ctx.secrets,
    fetchFn: ctx.fetchFn,
    saveSecret: ctx.saveSecret,
  });
  if (ctx.cursor?.start_page_token) {
    return await deltaSync(ctx, accessToken, ctx.cursor.start_page_token);
  }
  return await firstSync(ctx, accessToken);
}
