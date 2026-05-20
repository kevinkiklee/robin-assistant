import type { IntegrationContext } from '../_runtime/types.ts';

interface TokenResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
}

const TOKEN_URL = 'https://oauth2.googleapis.com/token';

/**
 * Returns a valid Google OAuth access token, refreshing from the configured refresh token if expired.
 * Caches the access token + expiry in integration_state KV.
 *
 * Required env: <prefix>_REFRESH_TOKEN, <prefix>_CLIENT_ID, <prefix>_CLIENT_SECRET
 * Where <prefix> is e.g. 'GMAIL' or 'GOOGLE_CALENDAR'.
 */
export async function getGoogleAccessToken(
  ctx: IntegrationContext,
  envPrefix: string,
): Promise<string> {
  const refreshToken = process.env[`${envPrefix}_REFRESH_TOKEN`];
  const clientId = process.env[`${envPrefix}_CLIENT_ID`];
  const clientSecret = process.env[`${envPrefix}_CLIENT_SECRET`];
  if (!refreshToken) throw new Error(`${envPrefix}_REFRESH_TOKEN not set`);
  if (!clientId) throw new Error(`${envPrefix}_CLIENT_ID not set`);
  if (!clientSecret) throw new Error(`${envPrefix}_CLIENT_SECRET not set`);

  // Check cached token
  const cached = ctx.state.get('google_access_token');
  const expiryStr = ctx.state.get('google_access_token_expiry');
  if (cached && expiryStr) {
    const expiry = Number.parseInt(expiryStr, 10);
    if (Number.isFinite(expiry) && Date.now() < expiry - 60_000) {
      return cached;
    }
  }

  const body = new URLSearchParams({
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: 'refresh_token',
  });
  const res = await ctx.fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) throw new Error(`google oauth refresh returned ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as TokenResponse;
  const expiry = Date.now() + data.expires_in * 1000;
  ctx.state.set('google_access_token', data.access_token);
  ctx.state.set('google_access_token_expiry', String(expiry));
  return data.access_token;
}
