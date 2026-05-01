#!/usr/bin/env node
// Template — auto-copied to user-data/scripts/ by skeleton-sync.
// Imports resolve only after copy; not runnable in place.
//
// One-shot Google OAuth setup for Calendar + Gmail sync.
//
// Usage:
//   node user-data/scripts/auth-google.js
//
// Prerequisites: in user-data/secrets/.env, set:
//   GOOGLE_OAUTH_CLIENT_ID=...
//   GOOGLE_OAUTH_CLIENT_SECRET=...
// Get these by creating an OAuth Desktop client in Google Cloud Console:
//   https://console.cloud.google.com/apis/credentials
//
// On success, writes GOOGLE_OAUTH_REFRESH_TOKEN to .env (atomic) and caches
// the initial access token in user-data/state/sync/google.json.

import { fileURLToPath } from 'node:url';
import { runAuthCodeFlow } from '../../system/scripts/lib/sync/oauth.js';
import { requireSecret, saveSecret } from '../../system/scripts/lib/sync/secrets.js';
import { saveCursor } from '../../system/scripts/lib/sync/cursor.js';

const SCOPES = [
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/gmail.readonly',
];

async function main() {
  const workspaceDir = fileURLToPath(new URL('../..', import.meta.url));

  let clientId, clientSecret;
  try {
    clientId = requireSecret(workspaceDir, 'GOOGLE_OAUTH_CLIENT_ID');
    clientSecret = requireSecret(workspaceDir, 'GOOGLE_OAUTH_CLIENT_SECRET');
  } catch (err) {
    console.error(`\n[auth-google] ${err.message}\n`);
    console.error(
      'Create an OAuth 2.0 Client ID (type: Desktop) at\n' +
      '  https://console.cloud.google.com/apis/credentials\n' +
      'then add these lines to user-data/secrets/.env:\n' +
      '  GOOGLE_OAUTH_CLIENT_ID=<your-client-id>\n' +
      '  GOOGLE_OAUTH_CLIENT_SECRET=<your-client-secret>\n'
    );
    process.exit(1);
  }

  const { refreshToken, accessToken, expiresAt } = await runAuthCodeFlow({
    provider: 'google',
    clientId,
    clientSecret,
    scopes: SCOPES,
    extraAuthParams: {
      access_type: 'offline', // required for refresh_token
      prompt: 'consent',      // ensures refresh_token even on re-auth
    },
  });

  saveSecret(workspaceDir, 'GOOGLE_OAUTH_REFRESH_TOKEN', refreshToken);
  saveCursor(workspaceDir, 'google', {
    access_token: accessToken,
    access_token_expires_at: expiresAt,
    auth_status: 'ok',
    last_auth_at: new Date().toISOString(),
  });

  console.log('\n[auth-google] success — refresh token saved to user-data/secrets/.env');
  console.log('[auth-google] you can now enable the Calendar and Gmail sync jobs:');
  console.log('  node bin/robin.js jobs enable sync-calendar');
  console.log('  node bin/robin.js jobs enable sync-gmail');
  console.log('  node user-data/scripts/sync-calendar.js --bootstrap');
  console.log('  node user-data/scripts/sync-gmail.js --bootstrap');
}

main().catch((err) => {
  console.error(`\n[auth-google] failed: ${err.message}`);
  process.exit(1);
});
