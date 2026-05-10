import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { _resetCache } from '../../src/integrations/_auth/google-token-cache.js';
import { sync } from '../../src/integrations/google_drive/sync.js';

function fakeFile(id) {
  return {
    id,
    name: `File${id}.txt`,
    mimeType: 'text/plain',
    modifiedTime: '2026-05-09T10:00:00Z',
    owners: [{ emailAddress: 'me@me.com' }],
    webViewLink: `https://drive.google.com/${id}`,
    parents: ['root'],
    shared: false,
    size: '100',
  };
}

test('first sync caps at 200 and saves start_page_token', async () => {
  _resetCache();
  const fetchFn = mock.fn(async (url) => {
    if (url.includes('/token'))
      return { ok: true, json: async () => ({ access_token: 'a', expires_in: 3600 }) };
    if (url.includes('/files?'))
      return { ok: true, json: async () => ({ files: [fakeFile('f1'), fakeFile('f2')] }) };
    if (url.includes('/changes/startPageToken'))
      return { ok: true, json: async () => ({ startPageToken: '999' }) };
    throw new Error(`unexpected: ${url}`);
  });
  const captured = [];
  const r = await sync({
    secrets: {
      GOOGLE_OAUTH_REFRESH_TOKEN: 'r',
      GOOGLE_OAUTH_CLIENT_ID: 'c',
      GOOGLE_OAUTH_CLIENT_SECRET: 's',
    },
    log: () => {},
    cursor: null,
    capture: async (rows) => {
      captured.push(...rows);
      return {};
    },
    fetchFn,
  });
  assert.equal(r.count, 2);
  assert.equal(r.cursor.start_page_token, '999');
});

test('delta sync uses changes.list', async () => {
  _resetCache();
  const fetchFn = mock.fn(async (url) => {
    if (url.includes('/token'))
      return { ok: true, json: async () => ({ access_token: 'a', expires_in: 3600 }) };
    if (url.includes('/changes?'))
      return {
        ok: true,
        json: async () => ({
          newStartPageToken: '1000',
          changes: [{ file: fakeFile('f10') }],
        }),
      };
    throw new Error(`unexpected: ${url}`);
  });
  const captured = [];
  const r = await sync({
    secrets: {
      GOOGLE_OAUTH_REFRESH_TOKEN: 'r',
      GOOGLE_OAUTH_CLIENT_ID: 'c',
      GOOGLE_OAUTH_CLIENT_SECRET: 's',
    },
    log: () => {},
    cursor: { start_page_token: '500' },
    capture: async (rows) => {
      captured.push(...rows);
      return {};
    },
    fetchFn,
  });
  assert.equal(r.count, 1);
  assert.equal(r.cursor.start_page_token, '1000');
});

test('delta sync filters out removed/no-file changes', async () => {
  _resetCache();
  const fetchFn = mock.fn(async (url) => {
    if (url.includes('/token'))
      return { ok: true, json: async () => ({ access_token: 'a', expires_in: 3600 }) };
    if (url.includes('/changes?'))
      return {
        ok: true,
        json: async () => ({
          newStartPageToken: '1001',
          changes: [{ file: fakeFile('f10') }, { removed: true, fileId: 'f-removed' }],
        }),
      };
    throw new Error(`unexpected: ${url}`);
  });
  const captured = [];
  await sync({
    secrets: {
      GOOGLE_OAUTH_REFRESH_TOKEN: 'r',
      GOOGLE_OAUTH_CLIENT_ID: 'c',
      GOOGLE_OAUTH_CLIENT_SECRET: 's',
    },
    log: () => {},
    cursor: { start_page_token: '500' },
    capture: async (rows) => {
      captured.push(...rows);
      return {};
    },
    fetchFn,
  });
  assert.equal(captured.length, 1);
  assert.equal(captured[0].external_id, 'f10');
});
