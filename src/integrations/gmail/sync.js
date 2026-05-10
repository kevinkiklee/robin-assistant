import { ensureFreshToken } from '../_auth/oauth2-google.js';
import {
  FIRST_SYNC_CAP,
  buildEventFromMessage,
  getMessage,
  getProfile,
  listHistory,
  listMessages,
  shouldSkipMessage,
} from './client.js';

async function firstSync(ctx, accessToken) {
  const profile = await getProfile({
    accessToken,
    fetchFn: ctx.fetchFn,
    signal: ctx.signal,
  });
  let pageToken = null;
  let total = 0;
  const events = [];
  do {
    const page = await listMessages({
      accessToken,
      q: 'newer_than:7d',
      pageToken,
      fetchFn: ctx.fetchFn,
      signal: ctx.signal,
    });
    pageToken = page.nextPageToken;
    for (const stub of page.messages ?? []) {
      if (total >= FIRST_SYNC_CAP) break;
      const msg = await getMessage({
        accessToken,
        id: stub.id,
        fetchFn: ctx.fetchFn,
        signal: ctx.signal,
      });
      if (shouldSkipMessage(msg)) continue;
      events.push(buildEventFromMessage(msg));
      total += 1;
    }
  } while (pageToken && total < FIRST_SYNC_CAP);
  await ctx.capture(events);
  return { count: events.length, cursor: { history_id: profile.historyId } };
}

async function deltaSync(ctx, accessToken, startHistoryId) {
  const events = [];
  let pageToken = null;
  let latestHistoryId = startHistoryId;
  try {
    do {
      const page = await listHistory({
        accessToken,
        startHistoryId,
        fetchFn: ctx.fetchFn,
        signal: ctx.signal,
      });
      latestHistoryId = page.historyId ?? latestHistoryId;
      for (const h of page.history ?? []) {
        for (const added of h.messagesAdded ?? []) {
          const stub = added.message;
          const msg = await getMessage({
            accessToken,
            id: stub.id,
            fetchFn: ctx.fetchFn,
            signal: ctx.signal,
          });
          if (shouldSkipMessage(msg)) continue;
          events.push(buildEventFromMessage(msg));
        }
      }
      pageToken = page.nextPageToken;
    } while (pageToken);
  } catch (e) {
    if (e.code === 'history_expired') {
      ctx.log('history_id expired, falling back to first-sync');
      return await firstSync(ctx, accessToken);
    }
    throw e;
  }
  await ctx.capture(events);
  return { count: events.length, cursor: { history_id: latestHistoryId } };
}

export async function sync(ctx) {
  const fresh = await ensureFreshToken('gmail', ctx.secrets, { fetchFn: ctx.fetchFn });
  ctx.secrets = fresh;
  const accessToken = fresh.access_token;
  if (ctx.cursor?.history_id) {
    return await deltaSync(ctx, accessToken, ctx.cursor.history_id);
  }
  return await firstSync(ctx, accessToken);
}
