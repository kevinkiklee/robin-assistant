// Template — auto-copied to user-data/scripts/lib/spotify/ by skeleton-sync.
// Imports resolve only after copy; not runnable in place.

import { fetchJson, AuthError } from '../../../../system/scripts/lib/sync/http.js';

export { AuthError };

const BASE = 'https://api.spotify.com/v1';

export class SpotifyClient {
  constructor(accessToken) {
    if (!accessToken) throw new Error('SpotifyClient: access token required');
    this.token = accessToken;
  }

  headers() {
    return { Authorization: `Bearer ${this.token}` };
  }

  async me() {
    return fetchJson(`${BASE}/me`, { headers: this.headers() });
  }

  async recentlyPlayed({ after, limit = 50 } = {}) {
    const u = new URL(`${BASE}/me/player/recently-played`);
    u.searchParams.set('limit', String(limit));
    if (after) u.searchParams.set('after', String(after));
    return fetchJson(u.toString(), { headers: this.headers() });
  }

  async topItems(type, { time_range = 'short_term', limit = 50 } = {}) {
    // type: 'tracks' | 'artists'
    const u = new URL(`${BASE}/me/top/${type}`);
    u.searchParams.set('time_range', time_range);
    u.searchParams.set('limit', String(limit));
    return fetchJson(u.toString(), { headers: this.headers() });
  }

  async myPlaylists({ cap = 100 } = {}) {
    const out = [];
    let offset = 0;
    while (offset < cap) {
      const u = new URL(`${BASE}/me/playlists`);
      u.searchParams.set('limit', '50');
      u.searchParams.set('offset', String(offset));
      const data = await fetchJson(u.toString(), { headers: this.headers() });
      out.push(...(data.items ?? []));
      if ((data.items ?? []).length < 50) break;
      offset += 50;
    }
    return out.slice(0, cap);
  }

  async playlistTracks(playlistId, { cap = 200 } = {}) {
    const out = [];
    let offset = 0;
    while (offset < cap) {
      const u = new URL(`${BASE}/playlists/${encodeURIComponent(playlistId)}/tracks`);
      u.searchParams.set('limit', '50');
      u.searchParams.set('offset', String(offset));
      u.searchParams.set('fields', 'items(track(id,name,artists(name),album(name),duration_ms))');
      const data = await fetchJson(u.toString(), { headers: this.headers() });
      out.push(...(data.items ?? []));
      if ((data.items ?? []).length < 50) break;
      offset += 50;
    }
    return out.slice(0, cap);
  }

  async audioFeatures(trackIds) {
    // up to 100 ids per request
    const out = [];
    for (let i = 0; i < trackIds.length; i += 100) {
      const slice = trackIds.slice(i, i + 100);
      const u = new URL(`${BASE}/audio-features`);
      u.searchParams.set('ids', slice.join(','));
      const data = await fetchJson(u.toString(), { headers: this.headers() });
      out.push(...(data.audio_features ?? []));
    }
    return out;
  }

  // Write CLIs
  async addToQueue(uri) {
    const u = new URL(`${BASE}/me/player/queue`);
    u.searchParams.set('uri', uri);
    const res = await fetch(u.toString(), { method: 'POST', headers: this.headers() });
    if (!res.ok) throw new Error(`HTTP ${res.status} adding to queue: ${await res.text()}`);
  }

  async skipNext() {
    const res = await fetch(`${BASE}/me/player/next`, { method: 'POST', headers: this.headers() });
    if (!res.ok) throw new Error(`HTTP ${res.status} skipping: ${await res.text()}`);
  }

  async addTracksToPlaylist(playlistId, trackUris) {
    const res = await fetch(`${BASE}/playlists/${encodeURIComponent(playlistId)}/tracks`, {
      method: 'POST',
      headers: { ...this.headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ uris: trackUris }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} adding to playlist: ${await res.text()}`);
    return res.json();
  }
}
