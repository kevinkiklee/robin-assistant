import { requireSecret } from '../../../config/secrets.js';

/**
 * Low-level GitHub REST fetch used by both github_write (mutations) and
 * github (read-sync). Callers that manage their own token (e.g. github sync)
 * pass `token` explicitly; callers that rely on requireSecret omit it.
 */
async function githubFetch(
  path,
  { method = 'GET', body, fetchFn = globalThis.fetch, signal, token },
) {
  const r = await fetchFn(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token ?? requireSecret('GITHUB_PAT')}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: body ? JSON.stringify(body) : undefined,
    signal,
  });
  if (!r.ok) {
    const errText = await r.text().catch(() => '');
    throw new Error(`github ${path} ${r.status}: ${errText}`);
  }
  return r.status === 204 ? null : await r.json();
}

export async function createIssue({ repo, title, body, labels, fetchFn, signal }) {
  return await githubFetch(`/repos/${repo}/issues`, {
    method: 'POST',
    body: { title, body, labels: labels ?? [] },
    fetchFn,
    signal,
  });
}

export async function addComment({ repo, issue_id, body, fetchFn, signal }) {
  return await githubFetch(`/repos/${repo}/issues/${issue_id}/comments`, {
    method: 'POST',
    body: { body },
    fetchFn,
    signal,
  });
}

export async function applyLabels({ repo, issue_id, add = [], remove = [], fetchFn, signal }) {
  if (add.length > 0) {
    await githubFetch(`/repos/${repo}/issues/${issue_id}/labels`, {
      method: 'POST',
      body: { labels: add },
      fetchFn,
      signal,
    });
  }
  for (const label of remove) {
    await githubFetch(`/repos/${repo}/issues/${issue_id}/labels/${encodeURIComponent(label)}`, {
      method: 'DELETE',
      fetchFn,
      signal,
    });
  }
  return { added: add, removed: remove };
}

export async function markNotificationRead({ notification_id, fetchFn, signal }) {
  return await githubFetch(`/notifications/threads/${notification_id}`, {
    method: 'PATCH',
    fetchFn,
    signal,
  });
}

// ---------------------------------------------------------------------------
// Read helpers — used by the github read-sync integration
// ---------------------------------------------------------------------------

export async function getAuthenticatedUser({ token, fetchFn, signal }) {
  return await githubFetch('/user', { fetchFn, signal, token });
}

/**
 * Lists public events for a user. Returns raw GitHub event objects.
 * `since` is an optional ISO string; events older than it are dropped client-side
 * (the GitHub API doesn't support server-side filtering for user events).
 * Uses fetchFn directly (not githubFetch) so that URL patterns stay unambiguous
 * in test mocks.
 */
export async function listUserEvents({ login, token, fetchFn, signal, since, cap = 300 }) {
  const events = [];
  let page = 1;
  const cutoff = since ? new Date(since) : null;
  while (events.length < cap) {
    const url = `https://api.github.com/users/${login}/events?per_page=100&page=${page}`;
    const r = await fetchFn(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      signal,
    });
    if (!r.ok) {
      const errText = await r.text().catch(() => '');
      throw new Error(`github /users/${login}/events ${r.status}: ${errText}`);
    }
    const batch = await r.json();
    if (!Array.isArray(batch) || batch.length === 0) break;
    for (const ev of batch) {
      if (cutoff && new Date(ev.created_at) <= cutoff) {
        // Events are newest-first; once we hit the cutoff the rest are older.
        return events;
      }
      events.push(ev);
      if (events.length >= cap) break;
    }
    if (batch.length < 100) break;
    page += 1;
  }
  return events;
}

/**
 * Lists notifications. Returns null on 403 so callers can handle fine-grained
 * PAT limitations gracefully (instead of throwing).
 */
export async function listNotifications({ token, fetchFn, signal }) {
  const r = await fetchFn('https://api.github.com/notifications?all=true&per_page=50', {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    signal,
  });
  if (r.status === 403) return null; // fine-grained PAT limitation
  if (!r.ok) {
    const errText = await r.text().catch(() => '');
    throw new Error(`github /notifications ${r.status}: ${errText}`);
  }
  return r.json();
}

/**
 * Lists repos starred by the authenticated user, capped at `cap`.
 * Uses fetchFn directly so URL patterns stay unambiguous in test mocks.
 */
export async function listStarredRepos({ token, fetchFn, signal, cap = 50 }) {
  const repos = [];
  let page = 1;
  while (repos.length < cap) {
    const url = `https://api.github.com/user/starred?per_page=100&page=${page}`;
    const r = await fetchFn(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      signal,
    });
    if (!r.ok) {
      const errText = await r.text().catch(() => '');
      throw new Error(`github /user/starred ${r.status}: ${errText}`);
    }
    const batch = await r.json();
    if (!Array.isArray(batch) || batch.length === 0) break;
    for (const repo of batch) {
      repos.push(repo);
      if (repos.length >= cap) break;
    }
    if (batch.length < 100) break;
    page += 1;
  }
  return repos;
}

/** Lists releases for a repo. */
export async function listReleases({ owner, repo, token, fetchFn, signal }) {
  return await githubFetch(`/repos/${owner}/${repo}/releases?per_page=10`, {
    fetchFn,
    signal,
    token,
  });
}
