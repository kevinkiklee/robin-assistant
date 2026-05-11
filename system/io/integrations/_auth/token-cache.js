import { saveSecret as saveSecretFn } from '../../../config/secrets.js';
import { ensureFreshToken, PROVIDERS } from './oauth2.js';

const caches = new Map(); // provider -> { access_token, expires_at }
const refreshPromises = new Map(); // provider -> Promise

export async function getAccessToken({ provider, secrets, fetchFn, saveSecret = saveSecretFn }) {
  if (!PROVIDERS[provider]) throw new Error(`unknown OAuth provider: ${provider}`);
  const now = Date.now();
  const cached = caches.get(provider);
  if (cached && cached.expires_at - now > 60_000) return cached.access_token;
  if (refreshPromises.has(provider))
    return refreshPromises.get(provider).then((c) => c.access_token);

  const promise = ensureFreshToken(provider, secrets, { fetchFn })
    .then((result) => {
      caches.set(provider, { access_token: result.access_token, expires_at: result.expires_at });
      if (PROVIDERS[provider].rotatesRefreshToken && result.refresh_token) {
        try {
          saveSecret(PROVIDERS[provider].refreshTokenEnv, result.refresh_token);
        } catch (e) {
          console.warn(
            `[token-cache] saveSecret(${PROVIDERS[provider].refreshTokenEnv}) failed: ${e.message}`,
          );
        }
      }
      return caches.get(provider);
    })
    .finally(() => {
      refreshPromises.delete(provider);
    });
  refreshPromises.set(provider, promise);
  return (await promise).access_token;
}

export function _resetCache(provider) {
  if (provider) {
    caches.delete(provider);
    refreshPromises.delete(provider);
  } else {
    caches.clear();
    refreshPromises.clear();
  }
}
