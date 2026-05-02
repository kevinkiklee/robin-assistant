// Template — auto-copied to user-data/ops/scripts/lib/github/ by scaffold-sync.
// Imports resolve only after copy; not runnable in place.

import { fetchJson, AuthError } from '../../../../system/scripts/sync/lib/http.js';

export { AuthError };

const BASE = 'https://api.github.com';

export class GitHubClient {
  constructor(pat) {
    if (!pat) throw new Error('GitHubClient: PAT required');
    this.pat = pat;
  }

  headers() {
    return {
      Authorization: `Bearer ${this.pat}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
  }

  async user() {
    return fetchJson(`${BASE}/user`, { headers: this.headers() });
  }

  // Public events for a user. Auto-paginates up to `cap`.
  async listUserEvents(username, { cap = 300 } = {}) {
    const out = [];
    for (let page = 1; page <= 10; page++) {
      const u = new URL(`${BASE}/users/${encodeURIComponent(username)}/events`);
      u.searchParams.set('per_page', '100');
      u.searchParams.set('page', String(page));
      const data = await fetchJson(u.toString(), { headers: this.headers() });
      out.push(...data);
      if (out.length >= cap || data.length < 100) break;
    }
    return out.slice(0, cap);
  }

  // Notifications visible to the authed user.
  async listNotifications({ all = true, since, before } = {}) {
    const u = new URL(`${BASE}/notifications`);
    u.searchParams.set('all', String(all));
    if (since) u.searchParams.set('since', since);
    if (before) u.searchParams.set('before', before);
    u.searchParams.set('per_page', '50');
    return fetchJson(u.toString(), { headers: this.headers() });
  }

  // Starred repos for the authed user. Auto-paginates up to `cap`.
  async listStarredRepos({ cap = 200 } = {}) {
    const out = [];
    for (let page = 1; page <= 10; page++) {
      const u = new URL(`${BASE}/user/starred`);
      u.searchParams.set('per_page', '100');
      u.searchParams.set('page', String(page));
      const data = await fetchJson(u.toString(), { headers: this.headers() });
      out.push(...data);
      if (out.length >= cap || data.length < 100) break;
    }
    return out.slice(0, cap);
  }

  // Latest releases for a repo. Returns the first page (default 30).
  async listReleases(owner, repo) {
    const u = new URL(`${BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases`);
    u.searchParams.set('per_page', '10');
    return fetchJson(u.toString(), { headers: this.headers() });
  }

  // Mark a notification thread as read (write CLI).
  async markNotificationRead(threadId) {
    const res = await fetch(`${BASE}/notifications/threads/${encodeURIComponent(threadId)}`, {
      method: 'PATCH',
      headers: this.headers(),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} marking notification read`);
  }

  // Create an issue (write CLI).
  async createIssue(owner, repo, { title, body, labels, assignees }) {
    const res = await fetch(`${BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues`, {
      method: 'POST',
      headers: { ...this.headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, body, labels, assignees }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} creating issue: ${await res.text()}`);
    return res.json();
  }

  // Comment on issue/PR (write CLI).
  async createComment(owner, repo, number, body) {
    const res = await fetch(
      `${BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${number}/comments`,
      {
        method: 'POST',
        headers: { ...this.headers(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ body }),
      }
    );
    if (!res.ok) throw new Error(`HTTP ${res.status} creating comment: ${await res.text()}`);
    return res.json();
  }

  // Apply labels to an issue/PR (write CLI). Replaces existing labels.
  async setLabels(owner, repo, number, labels) {
    const res = await fetch(
      `${BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${number}/labels`,
      {
        method: 'PUT',
        headers: { ...this.headers(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ labels }),
      }
    );
    if (!res.ok) throw new Error(`HTTP ${res.status} setting labels: ${await res.text()}`);
    return res.json();
  }
}
