import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { _resetCache } from '../../src/integrations/_auth/token-cache.js';
import { sync } from '../../src/integrations/youtube/sync.js';

test('sync produces all three event kinds with correct external_id prefixes', async () => {
  _resetCache('google');
  const fetchFn = mock.fn(async (url) => {
    if (url.includes('/token'))
      return { ok: true, json: async () => ({ access_token: 'a', expires_in: 3600 }) };
    if (url.includes('/subscriptions'))
      return {
        ok: true,
        json: async () => ({
          items: [
            {
              id: 'sub1',
              snippet: {
                resourceId: { channelId: 'c1' },
                title: 'Channel One',
                publishedAt: '2026-01-01T00:00:00Z',
              },
            },
          ],
        }),
      };
    if (url.includes('/playlists'))
      return {
        ok: true,
        json: async () => ({
          items: [
            {
              id: 'p1',
              snippet: { title: 'My Playlist', publishedAt: '2026-01-01T00:00:00Z' },
              contentDetails: { itemCount: 5 },
            },
          ],
        }),
      };
    if (url.includes('/videos'))
      return {
        ok: true,
        json: async () => ({
          items: [
            {
              id: 'v1',
              snippet: {
                title: 'Liked Vid',
                channelTitle: 'Channel One',
                channelId: 'c1',
                publishedAt: '2026-01-01T00:00:00Z',
              },
            },
          ],
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
    cursor: null,
    capture: async (rows) => {
      captured.push(...rows);
      return {};
    },
    fetchFn,
  });
  assert.equal(r.count, 3);
  const ids = captured.map((e) => e.external_id).sort();
  assert.deepEqual(ids, ['liked:v1', 'playlist:p1', 'sub:c1']);
});

test('sync paginates each kind independently', async () => {
  _resetCache('google');
  let subPage = 0;
  const fetchFn = mock.fn(async (url) => {
    if (url.includes('/token'))
      return { ok: true, json: async () => ({ access_token: 'a', expires_in: 3600 }) };
    if (url.includes('/subscriptions')) {
      subPage += 1;
      if (subPage === 1)
        return {
          ok: true,
          json: async () => ({
            items: [
              {
                id: 's1',
                snippet: {
                  resourceId: { channelId: 'c1' },
                  title: 'A',
                  publishedAt: '2026-01-01T00:00:00Z',
                },
              },
            ],
            nextPageToken: 'next',
          }),
        };
      return {
        ok: true,
        json: async () => ({
          items: [
            {
              id: 's2',
              snippet: {
                resourceId: { channelId: 'c2' },
                title: 'B',
                publishedAt: '2026-01-01T00:00:00Z',
              },
            },
          ],
        }),
      };
    }
    if (url.includes('/playlists')) return { ok: true, json: async () => ({ items: [] }) };
    if (url.includes('/videos')) return { ok: true, json: async () => ({ items: [] }) };
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
  assert.equal(captured.filter((e) => e.meta.kind === 'subscription').length, 2);
});
