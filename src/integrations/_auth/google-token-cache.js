import { ensureFreshToken } from './oauth2.js';

let cached = null; // { access_token, expires_at }
let refreshPromise = null; // dedupe concurrent refreshes

export async function getGoogleAccessToken({ secrets, fetchFn }) {
  const now = Date.now();
  if (cached && cached.expires_at - now > 60_000) return cached.access_token;
  if (refreshPromise) return refreshPromise.then((c) => c.access_token);
  refreshPromise = ensureFreshToken('google', secrets, { fetchFn }).finally(() => {
    refreshPromise = null;
  });
  cached = await refreshPromise;
  return cached.access_token;
}

// For tests
export function _resetCache() {
  cached = null;
  refreshPromise = null;
}
