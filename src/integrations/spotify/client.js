const BASE = 'https://api.spotify.com/v1';

async function spotifyGet(path, accessToken, { fetchFn = globalThis.fetch, signal } = {}) {
  const r = await fetchFn(`${BASE}${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal,
  });
  if (!r.ok) {
    const errText = await r.text().catch(() => '');
    const err = new Error(`spotify ${path} ${r.status}: ${errText}`);
    err.status = r.status;
    throw err;
  }
  return r.json();
}

export function createSpotifyClient(accessToken, { fetchFn = globalThis.fetch, signal } = {}) {
  const opts = { fetchFn, signal };

  return {
    me() {
      return spotifyGet('/me', accessToken, opts);
    },

    recentlyPlayed({ limit = 50 } = {}) {
      return spotifyGet(`/me/player/recently-played?limit=${limit}`, accessToken, opts);
    },

    topItems(kind, { time_range = 'medium_term', limit = 50 } = {}) {
      return spotifyGet(
        `/me/top/${kind}?time_range=${time_range}&limit=${limit}`,
        accessToken,
        opts,
      );
    },
  };
}
