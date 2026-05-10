import { getAccessToken } from '../_auth/token-cache.js';
import {
  buildEventFromLikedVideo,
  buildEventFromPlaylist,
  buildEventFromSubscription,
  listLikedVideos,
  listMyPlaylists,
  listSubscriptions,
} from './client.js';

async function paginateAll(fetcher, accessToken, ctx, builder) {
  const events = [];
  let pageToken = null;
  do {
    const page = await fetcher({
      accessToken,
      pageToken,
      fetchFn: ctx.fetchFn,
      signal: ctx.signal,
    });
    pageToken = page.nextPageToken;
    for (const item of page.items ?? []) {
      events.push(builder(item));
    }
  } while (pageToken);
  return events;
}

export async function sync(ctx) {
  const accessToken = await getAccessToken({
    provider: 'google',
    secrets: ctx.secrets,
    fetchFn: ctx.fetchFn,
    saveSecret: ctx.saveSecret,
  });
  const [subs, playlists, liked] = await Promise.all([
    paginateAll(listSubscriptions, accessToken, ctx, buildEventFromSubscription),
    paginateAll(listMyPlaylists, accessToken, ctx, buildEventFromPlaylist),
    paginateAll(listLikedVideos, accessToken, ctx, buildEventFromLikedVideo),
  ]);
  const events = [...subs, ...playlists, ...liked];
  await ctx.capture(events);
  return { count: events.length, cursor: { last_run_at: new Date().toISOString() } };
}
