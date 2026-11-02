import type { IntegrationContext } from './types.ts';

/**
 * Factory for a Google REST GET helper bound to one Google service.
 *
 * Gmail and Google Calendar (and likely any future Google integration: Drive,
 * People, Sheets) all hit JSON REST endpoints with the same shape — Bearer
 * auth, throw-on-non-2xx with status and response body in the error. Keeping
 * one implementation here means a fix to error handling (e.g. structured
 * logging, a retry policy, response body truncation) lands once and reaches
 * every Google integration.
 *
 * Usage:
 *   const gmailGet = makeGoogleGet('gmail', 'https://gmail.googleapis.com/...');
 *   const data = await gmailGet<ListResponse>(ctx, `/messages?q=${q}`, token);
 */
export function makeGoogleGet(serviceName: string, baseUrl: string) {
  return async function googleGet<T>(
    ctx: IntegrationContext,
    path: string,
    token: string,
  ): Promise<T> {
    const res = await ctx.fetch(`${baseUrl}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      throw new Error(`${serviceName} ${path} returned ${res.status}: ${await res.text()}`);
    }
    return (await res.json()) as T;
  };
}
