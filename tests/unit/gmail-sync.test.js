import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { sync } from '../../src/integrations/gmail/sync.js';

function fakeProfile() {
  return { historyId: 'h-100', emailAddress: 'me@example.com' };
}
function fakeMsg(id, snippet = 'snippet', labels = ['INBOX']) {
  return {
    id,
    threadId: `t-${id}`,
    snippet,
    labelIds: labels,
    internalDate: String(Date.now()),
    payload: {
      headers: [
        { name: 'Subject', value: `Subj ${id}` },
        { name: 'From', value: 'a@b.c' },
      ],
    },
  };
}

const fakeSecrets = {
  GOOGLE_OAUTH_CLIENT_ID: 'c',
  GOOGLE_OAUTH_CLIENT_SECRET: 's',
  GOOGLE_OAUTH_REFRESH_TOKEN: 'r',
};

function makeFetch(handler) {
  return mock.fn(async (url, opts) => handler(url, opts));
}

function tokenResponse() {
  return {
    ok: true,
    json: async () => ({ access_token: 'a-fresh', expires_in: 3600 }),
  };
}

test('first-sync paginates messages.list and skips TRASH/SPAM/PROMOTIONS', async () => {
  const captured = [];
  const fetchFn = makeFetch(async (url) => {
    if (url.includes('oauth2.googleapis.com/token')) return tokenResponse();
    if (url.includes('/profile')) return { ok: true, json: async () => fakeProfile() };
    if (url.includes('/messages?'))
      return {
        ok: true,
        json: async () => ({ messages: [{ id: 'm1' }, { id: 'm2' }, { id: 'm3' }] }),
      };
    if (url.includes('/messages/m1'))
      return { ok: true, status: 200, json: async () => fakeMsg('m1') };
    if (url.includes('/messages/m2'))
      return { ok: true, status: 200, json: async () => fakeMsg('m2', 's', ['SPAM']) };
    if (url.includes('/messages/m3'))
      return { ok: true, status: 200, json: async () => fakeMsg('m3') };
    throw new Error(`unexpected: ${url}`);
  });
  const ctx = {
    secrets: fakeSecrets,
    log: () => {},
    cursor: null,
    capture: async (rows) => {
      captured.push(...rows);
      return { inserted: rows.length, skipped: 0, updated: 0, errors: [] };
    },
    fetchFn,
  };
  const r = await sync(ctx);
  assert.equal(r.count, 2);
  assert.equal(r.cursor.history_id, 'h-100');
  assert.equal(captured.length, 2);
  assert.equal(captured[0].external_id, 'm1');
});

test('delta sync uses history.list when cursor present', async () => {
  const captured = [];
  const fetchFn = makeFetch(async (url) => {
    if (url.includes('oauth2.googleapis.com/token')) return tokenResponse();
    if (url.includes('/history?'))
      return {
        ok: true,
        status: 200,
        json: async () => ({
          historyId: 'h-200',
          history: [{ messagesAdded: [{ message: { id: 'm10' } }] }],
        }),
      };
    if (url.includes('/messages/m10'))
      return { ok: true, status: 200, json: async () => fakeMsg('m10') };
    throw new Error(`unexpected: ${url}`);
  });
  const ctx = {
    secrets: fakeSecrets,
    log: () => {},
    cursor: { history_id: 'h-100' },
    capture: async (rows) => {
      captured.push(...rows);
      return { inserted: rows.length, skipped: 0, updated: 0, errors: [] };
    },
    fetchFn,
  };
  const r = await sync(ctx);
  assert.equal(r.count, 1);
  assert.equal(r.cursor.history_id, 'h-200');
});

test('delta sync falls back to first-sync on history_id 404', async () => {
  let firstSyncCalled = false;
  const fetchFn = makeFetch(async (url) => {
    if (url.includes('oauth2.googleapis.com/token')) return tokenResponse();
    if (url.includes('/history?')) return { ok: false, status: 404 };
    if (url.includes('/profile')) {
      firstSyncCalled = true;
      return { ok: true, status: 200, json: async () => fakeProfile() };
    }
    if (url.includes('/messages?'))
      return { ok: true, status: 200, json: async () => ({ messages: [] }) };
    throw new Error(`unexpected: ${url}`);
  });
  const ctx = {
    secrets: fakeSecrets,
    log: () => {},
    cursor: { history_id: 'h-stale' },
    capture: async () => ({ inserted: 0, skipped: 0, updated: 0, errors: [] }),
    fetchFn,
  };
  const r = await sync(ctx);
  assert.equal(firstSyncCalled, true);
  assert.equal(r.cursor.history_id, 'h-100');
});
