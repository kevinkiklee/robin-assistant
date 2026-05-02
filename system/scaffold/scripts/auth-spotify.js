#!/usr/bin/env node
// Template — auto-copied to user-data/scripts/ by scaffold-sync.
// Imports resolve only after copy; not runnable in place.
//
// One-shot Spotify OAuth setup.
//
// Usage:
//   node user-data/scripts/auth-spotify.js
//
// Prerequisite: Create a Spotify app at
//   https://developer.spotify.com/dashboard
// Add http://127.0.0.1:<any-port>/oauth-callback to its redirect URIs (you
// can use any port like 8765 — the script picks one and prints it). Then in
// user-data/secrets/.env, set:
//   SPOTIFY_CLIENT_ID=...
//   SPOTIFY_CLIENT_SECRET=...

import { fileURLToPath } from 'node:url';
import { runAuthCodeFlow } from '../../system/scripts/lib/sync/oauth.js';
import { requireSecret, saveSecret } from '../../system/scripts/lib/sync/secrets.js';
import { saveCursor } from '../../system/scripts/lib/sync/cursor.js';

const SCOPES = [
  'user-read-recently-played',
  'user-top-read',
  'user-library-read',
  'playlist-read-private',
  'playlist-read-collaborative',
  'playlist-modify-private',
  'playlist-modify-public',
  'user-modify-playback-state',
  'user-read-playback-state',
];

// Spotify requires the redirect URI used in the auth flow to match an entry
// registered in the developer dashboard exactly. Use a fixed port so users
// can pre-register it. 8765 is unlikely to collide.
const REDIRECT_PORT = parseInt(process.env.SPOTIFY_AUTH_PORT || '8765', 10);

async function main() {
  const workspaceDir = fileURLToPath(new URL('../..', import.meta.url));

  let clientId, clientSecret;
  try {
    clientId = requireSecret(workspaceDir, 'SPOTIFY_CLIENT_ID');
    clientSecret = requireSecret(workspaceDir, 'SPOTIFY_CLIENT_SECRET');
  } catch (err) {
    console.error(`\n[auth-spotify] ${err.message}\n`);
    console.error(
      'Create a Spotify app at\n' +
      '  https://developer.spotify.com/dashboard\n' +
      `Add this redirect URI to it:\n  http://127.0.0.1:${REDIRECT_PORT}/oauth-callback\n` +
      'Then add these lines to user-data/secrets/.env:\n' +
      '  SPOTIFY_CLIENT_ID=<your-client-id>\n' +
      '  SPOTIFY_CLIENT_SECRET=<your-client-secret>\n'
    );
    process.exit(1);
  }

  const { refreshToken, accessToken, expiresAt } = await runAuthCodeFlow({
    provider: 'spotify',
    clientId,
    clientSecret,
    scopes: SCOPES,
    port: REDIRECT_PORT,
  });

  saveSecret(workspaceDir, 'SPOTIFY_REFRESH_TOKEN', refreshToken);
  saveCursor(workspaceDir, 'spotify', {
    access_token: accessToken,
    access_token_expires_at: expiresAt,
    auth_status: 'ok',
    last_auth_at: new Date().toISOString(),
  });

  console.log('\n[auth-spotify] success — refresh token saved to user-data/secrets/.env');
  console.log('[auth-spotify] enable the sync job:');
  console.log('  node bin/robin.js jobs enable sync-spotify');
  console.log('  node user-data/scripts/sync-spotify.js --bootstrap');
}

main().catch((err) => {
  console.error(`\n[auth-spotify] failed: ${err.message}`);
  process.exit(1);
});
