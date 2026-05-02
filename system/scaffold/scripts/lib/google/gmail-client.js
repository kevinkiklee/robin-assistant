// Template — auto-copied to user-data/scripts/lib/google/ by scaffold-sync.
// Imports resolve only after copy; not runnable in place.

import { fetchJson, AuthError } from '../../../../system/scripts/sync/lib/http.js';

export { AuthError };

const BASE = 'https://gmail.googleapis.com/gmail/v1';

export class GmailClient {
  constructor(accessToken) {
    if (!accessToken) throw new Error('GmailClient: access token required');
    this.token = accessToken;
  }

  headers() {
    return { Authorization: `Bearer ${this.token}` };
  }

  // List message ids matching a Gmail search query (e.g. 'newer_than:30d in:inbox').
  // Auto-paginates; returns up to `cap` ids.
  async listMessageIds(query, { cap = 1000 } = {}) {
    const ids = [];
    let pageToken;
    do {
      const u = new URL(`${BASE}/users/me/messages`);
      u.searchParams.set('q', query);
      u.searchParams.set('maxResults', '500');
      if (pageToken) u.searchParams.set('pageToken', pageToken);
      const data = await fetchJson(u.toString(), { headers: this.headers() });
      for (const m of data.messages ?? []) {
        ids.push({ id: m.id, threadId: m.threadId });
        if (ids.length >= cap) return ids;
      }
      pageToken = data.nextPageToken;
    } while (pageToken);
    return ids;
  }

  // Fetch a message in 'metadata' format (no body). Returns the raw API object.
  async getMessageMetadata(id) {
    const u = new URL(`${BASE}/users/me/messages/${encodeURIComponent(id)}`);
    u.searchParams.set('format', 'metadata');
    u.searchParams.set('metadataHeaders', 'From');
    u.searchParams.append('metadataHeaders', 'Subject');
    u.searchParams.append('metadataHeaders', 'Date');
    return fetchJson(u.toString(), { headers: this.headers() });
  }

  // Fetch a thread (full bodies). Lazy use only.
  async getThread(threadId) {
    return fetchJson(
      `${BASE}/users/me/threads/${encodeURIComponent(threadId)}?format=metadata`,
      { headers: this.headers() }
    );
  }

  async getProfile() {
    return fetchJson(`${BASE}/users/me/profile`, { headers: this.headers() });
  }
}

// Pull a header value from a Gmail message metadata payload.
export function header(msg, name) {
  const headers = msg?.payload?.headers ?? [];
  for (const h of headers) {
    if ((h.name ?? '').toLowerCase() === name.toLowerCase()) return h.value;
  }
  return null;
}
