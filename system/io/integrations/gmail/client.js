const SKIP_LABELS_DEFAULT = ['TRASH', 'SPAM', 'CATEGORY_PROMOTIONS'];
const FIRST_SYNC_CAP = 500;
const PAGE_SIZE = 100;

async function gmailFetch(path, { accessToken, fetchFn = globalThis.fetch, signal }) {
  const r = await fetchFn(`https://gmail.googleapis.com/gmail/v1/users/me${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal,
  });
  if (r.status === 401) {
    const err = new Error('gmail 401');
    err.code = 'auth_expired';
    throw err;
  }
  if (r.status === 404 || r.status === 410) {
    const err = new Error(`gmail history expired: ${r.status}`);
    err.code = 'history_expired';
    throw err;
  }
  if (!r.ok) throw new Error(`gmail ${path} failed: ${r.status}`);
  return await r.json();
}

export async function listMessages({ accessToken, q = '', pageToken, fetchFn, signal }) {
  const params = new URLSearchParams({ maxResults: String(PAGE_SIZE), q });
  if (pageToken) params.set('pageToken', pageToken);
  return await gmailFetch(`/messages?${params}`, { accessToken, fetchFn, signal });
}

export async function getMessage({ accessToken, id, fetchFn, signal }) {
  return await gmailFetch(
    `/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`,
    { accessToken, fetchFn, signal },
  );
}

export async function listHistory({ accessToken, startHistoryId, pageToken, fetchFn, signal }) {
  const params = new URLSearchParams({ startHistoryId, historyTypes: 'messageAdded' });
  if (pageToken) params.set('pageToken', pageToken);
  return await gmailFetch(`/history?${params}`, { accessToken, fetchFn, signal });
}

export async function getProfile({ accessToken, fetchFn, signal }) {
  return await gmailFetch('/profile', { accessToken, fetchFn, signal });
}

export async function getThread({ accessToken, threadId, fetchFn, signal }) {
  return await gmailFetch(`/threads/${threadId}`, { accessToken, fetchFn, signal });
}

export function buildEventFromMessage(msg) {
  const headers = msg.payload?.headers ?? [];
  const get = (name) =>
    headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';
  const subject = get('Subject');
  const from = get('From');
  const snippet = msg.snippet ?? '';
  const labels = msg.labelIds ?? [];
  return {
    source: 'gmail',
    content: `Subject: ${subject} | From: ${from}\n${snippet}`,
    ts: new Date(Number.parseInt(msg.internalDate, 10)),
    external_id: msg.id,
    meta: {
      gmail_id: msg.id,
      thread_id: msg.threadId,
      labels,
      internal_date: msg.internalDate,
    },
  };
}

export function shouldSkipMessage(msg, skipLabels = SKIP_LABELS_DEFAULT) {
  const labels = msg.labelIds ?? [];
  return labels.some((l) => skipLabels.includes(l));
}

export { FIRST_SYNC_CAP, PAGE_SIZE, SKIP_LABELS_DEFAULT };
