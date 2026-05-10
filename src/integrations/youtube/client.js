async function ytFetch(path, { accessToken, fetchFn = globalThis.fetch, signal }) {
  const r = await fetchFn(`https://www.googleapis.com/youtube/v3${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal,
  });
  if (!r.ok) throw new Error(`youtube ${path} ${r.status}`);
  return await r.json();
}

export async function listSubscriptions({ accessToken, pageToken, fetchFn, signal }) {
  const params = new URLSearchParams({ part: 'snippet', mine: 'true', maxResults: '50' });
  if (pageToken) params.set('pageToken', pageToken);
  return await ytFetch(`/subscriptions?${params}`, { accessToken, fetchFn, signal });
}

export async function listMyPlaylists({ accessToken, pageToken, fetchFn, signal }) {
  const params = new URLSearchParams({
    part: 'snippet,contentDetails',
    mine: 'true',
    maxResults: '50',
  });
  if (pageToken) params.set('pageToken', pageToken);
  return await ytFetch(`/playlists?${params}`, { accessToken, fetchFn, signal });
}

export async function listLikedVideos({ accessToken, pageToken, fetchFn, signal }) {
  const params = new URLSearchParams({
    part: 'snippet',
    myRating: 'like',
    maxResults: '50',
  });
  if (pageToken) params.set('pageToken', pageToken);
  return await ytFetch(`/videos?${params}`, { accessToken, fetchFn, signal });
}

export function buildEventFromSubscription(item) {
  const channelId = item.snippet?.resourceId?.channelId ?? item.id;
  const channelTitle = item.snippet?.title ?? '(unknown)';
  return {
    source: 'youtube',
    content: `sub: ${channelTitle}`,
    ts: new Date(item.snippet?.publishedAt ?? Date.now()),
    external_id: `sub:${channelId}`,
    meta: { kind: 'subscription', channel_id: channelId, channel_title: channelTitle },
  };
}

export function buildEventFromPlaylist(item) {
  const playlistId = item.id;
  const title = item.snippet?.title ?? '(untitled)';
  const itemCount = item.contentDetails?.itemCount ?? 0;
  return {
    source: 'youtube',
    content: `playlist: ${title} (${itemCount} videos)`,
    ts: new Date(item.snippet?.publishedAt ?? Date.now()),
    external_id: `playlist:${playlistId}`,
    meta: { kind: 'playlist', playlist_id: playlistId, title, item_count: itemCount },
  };
}

export function buildEventFromLikedVideo(item) {
  const videoId = item.id;
  const title = item.snippet?.title ?? '(untitled)';
  const channelTitle = item.snippet?.channelTitle ?? '(unknown)';
  return {
    source: 'youtube',
    content: `liked: ${title} · ${channelTitle}`,
    ts: new Date(item.snippet?.publishedAt ?? Date.now()),
    external_id: `liked:${videoId}`,
    meta: {
      kind: 'liked_video',
      video_id: videoId,
      channel_id: item.snippet?.channelId,
      channel_title: channelTitle,
      title,
    },
  };
}
