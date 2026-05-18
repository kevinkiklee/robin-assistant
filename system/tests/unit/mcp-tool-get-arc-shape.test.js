// Snapshot test for get_arc: validates formatArc helper wiring.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGetArcTool } from '../../io/mcp/tools/get-arc.js';

function makeDb(arc) {
  // getArc returns `rows?.[0] ?? rows ?? null`. To make that resolve to
  // null we need `rows` itself to be null/undefined, so the outer collect
  // tuple is `[null]`. For a present arc, return `[[arc]]`.
  return {
    query() {
      return {
        async collect() {
          return arc ? [[arc]] : [null];
        },
      };
    },
  };
}

test('get_arc returns header/summary/linked_entities/recent_events from formatArc', async () => {
  const linked = Array.from({ length: 25 }, (_, i) => `entities:e${i}`);
  const episodes = Array.from({ length: 15 }, (_, i) => `episodes:ep${i}`);
  const arc = {
    id: 'arcs:abc',
    name: 'My Arc',
    summary: 'Some summary',
    status: 'active',
    started_at: '2026-01-01T00:00:00.000Z',
    last_activity_at: '2026-02-01T00:00:00.000Z',
    ended_at: null,
    entity_ids: linked,
    meta: { episode_ids: episodes },
  };
  const tool = createGetArcTool({ db: makeDb(arc) });
  const r = await tool.handler({ arc_id: 'arcs:abc' });
  assert.equal(r.header.id, 'arcs:abc');
  assert.equal(r.header.name, 'My Arc');
  assert.equal(r.header.kind, 'arc');
  assert.equal(r.header.total_entities, 25);
  assert.equal(r.header.total_events, 15);
  assert.equal(r.summary, 'Some summary');
  assert.equal(r.linked_entities.length, 10);
  assert.equal(r.recent_events.length, 10);
  assert.equal(r.meta.trimmed, true);
  // Legacy top-level fields preserved
  assert.equal(r.status, 'active');
  assert.equal(r.last_activity_at, '2026-02-01T00:00:00.000Z');
});

test('get_arc full:true returns untrimmed lists', async () => {
  const linked = Array.from({ length: 25 }, (_, i) => `entities:e${i}`);
  const episodes = Array.from({ length: 15 }, (_, i) => `episodes:ep${i}`);
  const arc = {
    id: 'arcs:abc',
    name: 'X',
    summary: null,
    status: 'active',
    started_at: '2026-01-01T00:00:00.000Z',
    last_activity_at: '2026-02-01T00:00:00.000Z',
    ended_at: null,
    entity_ids: linked,
    meta: { episode_ids: episodes },
  };
  const tool = createGetArcTool({ db: makeDb(arc) });
  const r = await tool.handler({ arc_id: 'arcs:abc', full: true });
  assert.equal(r.linked_entities.length, 25);
  assert.equal(r.recent_events.length, 15);
  assert.equal(r.entity_ids.length, 25);
  assert.equal(r.episode_ids.length, 15);
  assert.equal(r.meta.trimmed, false);
});

test('get_arc returns not_found for unknown id', async () => {
  const tool = createGetArcTool({ db: makeDb(null) });
  const r = await tool.handler({ arc_id: 'arcs:missing' });
  assert.equal(r.error, 'not_found');
});
