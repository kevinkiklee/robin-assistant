import { getAccessToken } from '../_auth/token-cache.js';
import { createSpotifyClient } from './client.js';

const WINDOWS = ['short_term', 'medium_term', 'long_term'];
const TOP_LIMIT = 50;

function utcMonthBucket(dateStr) {
  const d = new Date(dateStr);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

function currentMonthBucket() {
  return utcMonthBucket(new Date().toISOString());
}

function buildPlayedEvent(item) {
  const { track, played_at } = item;
  const artists = (track.artists ?? []).map((a) => a.name).join(', ') || 'Unknown Artist';
  const album = track.album?.name ?? '';
  const content = `played ${track.name} by ${artists}${album ? ` — ${album}` : ''}`;
  return {
    external_id: `spotify:played:${played_at}`,
    source: 'spotify',
    ts: played_at,
    content,
    meta: {
      kind: 'spotify_played',
      track_id: track.id,
      track_name: track.name,
      artists: track.artists?.map((a) => a.name) ?? [],
      album: track.album?.name ?? '',
      duration_ms: track.duration_ms ?? null,
    },
  };
}

function buildTopTrackEvent(track, window, month) {
  const artists = (track.artists ?? []).map((a) => a.name).join(', ') || 'Unknown Artist';
  const album = track.album?.name ?? '';
  return {
    external_id: `spotify:top_track:${window}:${month}:${track.id}`,
    source: 'spotify',
    ts: new Date().toISOString(),
    content: `top track (${window}) ${track.name} by ${artists}${album ? ` — ${album}` : ''}`,
    meta: {
      kind: 'spotify_top_track',
      window,
      month,
      track_id: track.id,
      track_name: track.name,
      artists: track.artists?.map((a) => a.name) ?? [],
      album: track.album?.name ?? '',
    },
  };
}

function buildTopArtistEvent(artist, window, month) {
  return {
    external_id: `spotify:top_artist:${window}:${month}:${artist.id}`,
    source: 'spotify',
    ts: new Date().toISOString(),
    content: `top artist (${window}) ${artist.name}`,
    meta: {
      kind: 'spotify_top_artist',
      window,
      month,
      artist_id: artist.id,
      artist_name: artist.name,
      genres: artist.genres ?? [],
    },
  };
}

export async function sync(ctx) {
  const client =
    ctx._client ??
    createSpotifyClient(
      await getAccessToken({
        provider: 'spotify',
        secrets: ctx.secrets,
        fetchFn: ctx.fetchFn,
        saveSecret: ctx.saveSecret,
      }),
      { fetchFn: ctx.fetchFn, signal: ctx.signal },
    );

  const month = currentMonthBucket();
  const log = ctx.log ?? (() => {});

  // Fetch recently-played and all top items in parallel
  const [recentResp, ...topResponses] = await Promise.all([
    client.recentlyPlayed({ limit: 50 }),
    ...WINDOWS.flatMap((window) => [
      client.topItems('tracks', { time_range: window, limit: TOP_LIMIT }),
      client.topItems('artists', { time_range: window, limit: TOP_LIMIT }),
    ]),
  ]);

  // Build recently-played events
  const playedItems = recentResp.items ?? [];
  const playedEvents = playedItems.map(buildPlayedEvent);

  // Gap detection
  if (ctx.cursor?.last_played_at && playedItems.length === 50) {
    const oldestPlayedAt = playedItems[playedItems.length - 1].played_at;
    if (oldestPlayedAt > ctx.cursor.last_played_at) {
      log('[spotify] gap detected: >50 plays since last sync; consider tighter cadence');
    }
  }

  // Build top-items events
  // topResponses layout: [tracks:short, artists:short, tracks:medium, artists:medium, tracks:long, artists:long]
  const topEvents = [];
  for (let i = 0; i < WINDOWS.length; i++) {
    const window = WINDOWS[i];
    const tracksResp = topResponses[i * 2];
    const artistsResp = topResponses[i * 2 + 1];
    for (const track of tracksResp.items ?? []) {
      topEvents.push(buildTopTrackEvent(track, window, month));
    }
    for (const artist of artistsResp.items ?? []) {
      topEvents.push(buildTopArtistEvent(artist, window, month));
    }
  }

  const events = [...playedEvents, ...topEvents];
  const result = await ctx.capture(events);

  const now = new Date().toISOString();
  const newestPlayedAt = playedItems.length > 0 ? playedItems[0].played_at : null;

  return {
    count: result?.count ?? events.length,
    cursor: {
      last_played_at: newestPlayedAt ?? ctx.cursor?.last_played_at ?? null,
      last_top_refresh_at: now,
      last_gap_warning_at: ctx.cursor?.last_gap_warning_at ?? null,
    },
  };
}
