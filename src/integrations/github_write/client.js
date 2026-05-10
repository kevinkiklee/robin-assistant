import { requireSecret } from '../../secrets/dotenv-io.js';

async function githubFetch(path, { method = 'GET', body, fetchFn = globalThis.fetch, signal }) {
  const r = await fetchFn(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${requireSecret('GITHUB_PAT')}`,
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
