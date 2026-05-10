import assert from 'node:assert';
import { test } from 'node:test';
import { buildEpisodeRow } from '../../src/migrate-v1/phases/episode.js';

test('buildEpisodeRow preserves v1 title in meta', () => {
  const row = buildEpisodeRow({
    id: 'episode:e1',
    kind: 'session',
    title: 'Morning standup',
    started_at: '2026-01-01T09:00:00Z',
    ended_at: '2026-01-01T09:15:00Z',
    summary: 'discussed roadmap',
    meta: { foo: 'bar' },
  });
  assert.equal(row.source, 'migration');
  assert.equal(row.summary, 'discussed roadmap');
  assert.equal(row.meta.kind, 'v1_episode');
  assert.equal(row.meta.title, 'Morning standup');
  assert.equal(row.meta.v1_kind, 'session');
  assert.equal(row.meta.foo, 'bar');
  assert.equal(row.meta.from_v1.v1_id, 'episode:e1');
  assert.equal(row.started_at, '2026-01-01T09:00:00Z');
  assert.equal(row.ended_at, '2026-01-01T09:15:00Z');
});

test('buildEpisodeRow preserves null ended_at', () => {
  const row = buildEpisodeRow({
    id: 'episode:e2',
    kind: 'daily',
    title: null,
    started_at: '2026-02-01T00:00:00Z',
    summary: 's',
  });
  assert.equal(row.ended_at, null);
});
