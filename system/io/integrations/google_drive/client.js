const FIRST_SYNC_CAP = 200;
const FIRST_SYNC_DAYS = 30;
const BODY_FETCH_CAP_BYTES = 100_000;
const TEXT_MIMES = ['text/plain', 'text/markdown', 'text/csv', 'application/json'];
const WORKSPACE_DOC = 'application/vnd.google-apps.document';

const FIELDS = 'id,name,mimeType,modifiedTime,owners,webViewLink,parents,shared,size';

async function driveFetch(path, { accessToken, fetchFn = globalThis.fetch, signal }) {
  const r = await fetchFn(`https://www.googleapis.com/drive/v3${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal,
  });
  if (!r.ok) throw new Error(`drive ${path} ${r.status}`);
  return await r.json();
}

export async function getStartPageToken({ accessToken, fetchFn, signal }) {
  return await driveFetch('/changes/startPageToken', { accessToken, fetchFn, signal });
}

export async function listFiles({ accessToken, q, pageToken, fetchFn, signal }) {
  const params = new URLSearchParams({
    fields: `nextPageToken,files(${FIELDS})`,
    pageSize: '100',
    orderBy: 'modifiedTime desc',
  });
  if (q) params.set('q', q);
  if (pageToken) params.set('pageToken', pageToken);
  return await driveFetch(`/files?${params}`, { accessToken, fetchFn, signal });
}

export async function listChanges({ accessToken, pageToken, fetchFn, signal }) {
  const params = new URLSearchParams({
    fields: `newStartPageToken,nextPageToken,changes(file(${FIELDS}),removed,fileId)`,
    pageToken,
  });
  return await driveFetch(`/changes?${params}`, { accessToken, fetchFn, signal });
}

export async function getFileMetadata({ accessToken, fileId, fetchFn, signal }) {
  return await driveFetch(`/files/${fileId}?fields=${FIELDS}`, { accessToken, fetchFn, signal });
}

export async function getFileBody({
  accessToken,
  fileId,
  mimeType,
  fetchFn = globalThis.fetch,
  signal,
}) {
  if (mimeType === WORKSPACE_DOC) {
    const r = await fetchFn(
      `https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=text/plain`,
      {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal,
      },
    );
    if (!r.ok) throw new Error(`drive export ${fileId} ${r.status}`);
    const text = await r.text();
    if (text.length > BODY_FETCH_CAP_BYTES) {
      return { truncated: true, body: text.slice(0, BODY_FETCH_CAP_BYTES) };
    }
    return { truncated: false, body: text };
  }
  if (!TEXT_MIMES.some((m) => mimeType?.startsWith(m))) {
    return null;
  }
  const r = await fetchFn(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal,
  });
  if (!r.ok) throw new Error(`drive download ${fileId} ${r.status}`);
  const text = await r.text();
  if (text.length > BODY_FETCH_CAP_BYTES) {
    return { truncated: true, body: text.slice(0, BODY_FETCH_CAP_BYTES) };
  }
  return { truncated: false, body: text };
}

export function buildEventFromFile(file) {
  const owner = file.owners?.[0]?.emailAddress ?? '(unknown)';
  return {
    source: 'google_drive',
    content: `${file.name} · ${file.mimeType} · modified ${file.modifiedTime} · owner ${owner}`,
    ts: new Date(file.modifiedTime),
    external_id: file.id,
    meta: {
      file_id: file.id,
      mime_type: file.mimeType,
      web_view_link: file.webViewLink,
      owners: (file.owners ?? []).map((o) => o.emailAddress),
      modified_time: file.modifiedTime,
      parents: file.parents,
      shared: file.shared,
      size: file.size,
    },
  };
}

export { BODY_FETCH_CAP_BYTES, FIRST_SYNC_CAP, FIRST_SYNC_DAYS, TEXT_MIMES, WORKSPACE_DOC };
