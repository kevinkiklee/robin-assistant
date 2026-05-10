import assert from 'node:assert';
import { test } from 'node:test';
import { buildCaptureRow } from '../../src/migrate-v1/phases/capture.js';

test('buildCaptureRow shape — episode_id resolved when known', () => {
  const row = buildCaptureRow(
    {
      id: 'capture:c1',
      body: 'hello',
      kind: 'fact',
      origin: 'user',
      source: 'cli',
      ts: '2026-01-01T00:00:00Z',
      meta: { x: 1 },
    },
    { v2_episode_id: 'episodes:newep' },
  );
  assert.equal(row.content, 'hello');
  assert.equal(row.source, 'migration');
  assert.equal(row.episode_id, 'episodes:newep');
  assert.equal(row.meta.kind, 'v1_capture');
  assert.equal(row.meta.v1_kind, 'fact');
  assert.equal(row.meta.x, 1);
  assert.equal(row.external_id, 'v1:capture:c1');
  assert.equal(row.trust, 'trusted');
  assert.ok(row.content_hash); // sha256 of 'hello'
});

test('buildCaptureRow without episode → episode_id key absent', () => {
  const row = buildCaptureRow(
    {
      id: 'capture:c2',
      body: 'orphan',
      kind: 'journal',
      origin: 'user',
      source: 'cli',
      ts: '2026-01-01T00:00:00Z',
    },
    { v2_episode_id: null },
  );
  // We omit the field entirely so SurrealDB stores NONE rather than coercing JS null.
  assert.ok(
    !('episode_id' in row) || row.episode_id === undefined,
    'expected episode_id absent or undefined when v2_episode_id is null',
  );
});

test('buildCaptureRow preserves v1 archived_at into meta', () => {
  const row = buildCaptureRow(
    {
      id: 'capture:c3',
      body: 'old',
      kind: 'fact',
      origin: 'user',
      source: 'cli',
      ts: '2026-01-01T00:00:00Z',
      archived_at: '2026-04-01T00:00:00Z',
    },
    { v2_episode_id: null },
  );
  assert.equal(row.meta.v1_archived_at, '2026-04-01T00:00:00Z');
});
