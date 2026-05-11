import { requireSecret, saveSecret } from '../../../config/secrets.js';
import { getAccessToken } from '../_auth/token-cache.js';

function buildSecrets() {
  return {
    SPOTIFY_REFRESH_TOKEN: requireSecret('SPOTIFY_REFRESH_TOKEN'),
    SPOTIFY_CLIENT_ID: requireSecret('SPOTIFY_CLIENT_ID'),
    SPOTIFY_CLIENT_SECRET: requireSecret('SPOTIFY_CLIENT_SECRET'),
  };
}

async function spotifyFetch(path, { method = 'GET', body, fetchFn = globalThis.fetch, signal }) {
  const accessToken = await getAccessToken({
    provider: 'spotify',
    secrets: buildSecrets(),
    fetchFn,
    saveSecret,
  });
  const r = await fetchFn(`https://api.spotify.com/v1${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
    signal,
  });
  if (!r.ok) {
    const errText = await r.text().catch(() => '');
    const err = new Error(`spotify ${path} ${r.status}: ${errText}`);
    err.status = r.status;
    throw err;
  }
  return r.status === 204 ? null : await r.json();
}

export async function queueTrack({ track_uri, fetchFn, signal }) {
  const uri = track_uri.startsWith('spotify:') ? track_uri : `spotify:track:${track_uri}`;
  const params = new URLSearchParams({ uri });
  return await spotifyFetch(`/me/player/queue?${params}`, { method: 'POST', fetchFn, signal });
}

export async function skipTrack({ fetchFn, signal } = {}) {
  return await spotifyFetch('/me/player/next', { method: 'POST', fetchFn, signal });
}

export async function addToPlaylist({ playlist_id, track_uris, fetchFn, signal }) {
  const uris = track_uris.map((u) => (u.startsWith('spotify:') ? u : `spotify:track:${u}`));
  return await spotifyFetch(`/playlists/${playlist_id}/tracks`, {
    method: 'POST',
    body: { uris },
    fetchFn,
    signal,
  });
}
