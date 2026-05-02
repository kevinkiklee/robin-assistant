---
name: sync-spotify
description: Pull Spotify recently-played + top tracks/artists + playlists.
runtime: node
enabled: false
schedule: "0 */4 * * *"
command: node user-data/runtime/scripts/sync-spotify.js
catch_up: true
timeout_minutes: 5
notify_on_failure: true
---

Pulls last 50 recently-played tracks (append-only ledger; dedup by played_at),
top tracks/artists for 3 time windows (4w / 6m / all-time), and on bootstrap
also dumps owned playlists. Lazy-caches Spotify audio-features per track.

Disabled by default. Enable after running:

  node user-data/runtime/scripts/auth-spotify.js
  node user-data/runtime/scripts/sync-spotify.js --bootstrap
  node bin/robin.js jobs enable sync-spotify

Requires SPOTIFY_REFRESH_TOKEN/CLIENT_ID/CLIENT_SECRET in user-data/runtime/secrets/.env.
