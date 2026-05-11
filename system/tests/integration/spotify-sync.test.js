import assert from 'node:assert';
import { test } from 'node:test';
import { sync } from '../../io/integrations/spotify/sync.js';

function makeClient({ played = [], top = {} }) {
  return {
    me: async () => ({ id: 'kev', display_name: 'Kev' }),
    recentlyPlayed: async () => ({ items: played }),
    topItems: async (kind, { time_range }) => ({ items: top[`${kind}:${time_range}`] ?? [] }),
  };
}

test('spotify sync captures recently-played + top items with month-bucket', async () => {
  const captured = [];
  const ctx = {
    secrets: { SPOTIFY_REFRESH_TOKEN: 'r', SPOTIFY_CLIENT_ID: 'c', SPOTIFY_CLIENT_SECRET: 's' },
    fetchFn: globalThis.fetch,
    saveSecret: () => {},
    capture: async (evs) => {
      captured.push(...evs);
      return { count: evs.length };
    },
    log: () => {},
    cursor: null,
    _client: makeClient({
      played: [
        {
          played_at: '2026-05-09T12:00:00Z',
          track: {
            id: 't1',
            name: 'Song',
            artists: [{ name: 'A' }],
            album: { name: 'Alb' },
            duration_ms: 200000,
          },
        },
      ],
      top: {
        'tracks:short_term': [
          { id: 't1', name: 'Song', artists: [{ name: 'A' }], album: { name: 'Alb' } },
        ],
        'artists:short_term': [{ id: 'a1', name: 'A', genres: ['indie'] }],
      },
    }),
  };
  const out = await sync(ctx);
  assert.ok(out.count >= 3);
  const ids = captured.map((e) => e.external_id);
  assert.ok(ids.some((i) => i.startsWith('spotify:played:')));
  assert.ok(ids.some((i) => /^spotify:top_track:short_term:\d{4}-\d{2}:t1$/.test(i)));
  assert.ok(ids.some((i) => /^spotify:top_artist:short_term:\d{4}-\d{2}:a1$/.test(i)));
});

test('spotify sync logs gap when recently-played overflows', async () => {
  const logs = [];
  const fifty = Array.from({ length: 50 }, (_, i) => ({
    played_at: `2026-05-10T${String(i % 24).padStart(2, '0')}:00:00Z`,
    track: { id: `t${i}`, name: `s${i}`, artists: [], album: {} },
  }));
  const ctx = {
    secrets: {},
    fetchFn: globalThis.fetch,
    saveSecret: () => {},
    capture: async () => ({ count: 0 }),
    log: (s) => logs.push(s),
    cursor: { last_played_at: '2026-05-01T00:00:00Z' },
    _client: makeClient({ played: fifty, top: {} }),
  };
  await sync(ctx);
  assert.ok(
    logs.some((l) => /gap detected/.test(l)),
    'expected gap warning in logs',
  );
});
