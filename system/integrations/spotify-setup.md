# Spotify setup — listening sync

Pulls your recently-played tracks, top tracks/artists across three time
windows, and your playlist list. Some endpoints are gated by Spotify's
late-2024 Web API restrictions for new apps — see "Limitations" below.

## 1. Create a Spotify app

1. Open https://developer.spotify.com/dashboard
2. **Create app**
   - Name: `Robin` (anything works)
   - Description: anything
   - **Redirect URI:** `http://127.0.0.1:8765/oauth-callback` ← exact;
     Spotify *requires* the loopback IP `127.0.0.1`, not the hostname
     `localhost` (Spotify rejects `http://localhost` as "not secure")
   - APIs used: Web API (default)
   - Agree to terms → Save
3. Open the app → **Settings**
4. Copy **Client ID**, click **View client secret** and copy that too.

## 2. Add to `.env`

```env
SPOTIFY_CLIENT_ID=<your-client-id>
SPOTIFY_CLIENT_SECRET=<your-client-secret>
```

(`SPOTIFY_REFRESH_TOKEN=` will be filled in by the next step.)

## 3. Run the OAuth flow

```sh
node user-data/ops/scripts/auth-spotify.js
```

The script listens on port 8765 by default (override with
`SPOTIFY_AUTH_PORT=<port>`; if you change it, update the redirect URI in
the Spotify dashboard to match). Click **Agree** in the consent screen.

## 4. Bootstrap and enable

```sh
node user-data/ops/scripts/sync-spotify.js --bootstrap
node bin/robin.js jobs enable sync-spotify
```

Default schedule: every 4 hours. Spotify caps `recently-played` at the
last 50 tracks, so set the cron more aggressively if you listen heavily.

## Limitations (Spotify Web API changes, Nov 2024+)

Spotify deprecated several endpoints for apps **created after late 2024**.
`sync-spotify` handles each of these by catching the `403` and skipping
that section gracefully:

| Endpoint | Status | Effect on Robin |
|---|---|---|
| `/audio-features` | Deprecated for new apps | No `audio-features/` cache files; rest of sync still runs |
| `/playlists/{id}/tracks` | Restricted for new apps (even on user-owned playlists) | Playlist *names* are written, but track contents are not |
| `/audio-analysis`, `/recommendations`, `/related-artists`, `/featured-playlists` | Deprecated for new apps | Robin does not use these |

Apps created before late 2024 may still have access to these endpoints
("Extended Quota" mode is also relevant for high-traffic apps). If you
have such an app, the same code paths will populate the corresponding
files automatically — no edits needed.

## What does work

- `/me/player/recently-played` — last 50 tracks with timestamps
- `/me/top/tracks` and `/me/top/artists` — three time windows
  (4-week / 6-month / all-time)
- `/me/tracks` — your saved tracks library
- `/me/playlists` — names, owners, track counts (no track contents)
- `/me/player` write actions — queue, skip, playlist-add (via
  `spotify-write.js`)

## Scopes

`user-read-recently-played`, `user-top-read`, `user-library-read`,
`playlist-read-private`, `playlist-read-collaborative`,
`playlist-modify-private`, `playlist-modify-public`,
`user-modify-playback-state`, `user-read-playback-state`. Modify scopes
are present so the write CLI can queue/skip/add to playlists; sync itself
is read-only.
