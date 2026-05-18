// Snapshot test for list_arcs: validates formatJournal helper wiring.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createListArcsTool } from '../../io/mcp/tools/list-arcs.js';

function makeArc(i) {
  return {
    id: `arcs:arc${i}`,
    name: `Arc ${i}`,
    summary: `summary ${i}`,
    status: 'active',
    started_at: new Date(2026, 0, i + 1).toISOString(),
    last_activity_at: new Date(2026, 0, i + 1, 12).toISOString(),
    ended_at: null,
    entity_ids: [`entities:e${i}a`, `entities:e${i}b`],
  };
}

function makeDb(arcs) {
  // listArcs reads via `select` + ordering; mock by returning rows directly.
  return {
    query() {
      return {
        async collect() {
          return [arcs];
        },
      };
    },
  };
}

test('list_arcs trims to limit and exposes meta.trimmed=true when over', async () => {
  const arcs = Array.from({ length: 60 }, (_, i) => makeArc(i));
  const tool = createListArcsTool({ db: makeDb(arcs) });
  const r = await tool.handler({ limit: 20 });
  assert.equal(r.arcs.length, 20);
  assert.equal(r.meta.total, 60);
  assert.equal(r.meta.shown, 20);
  assert.equal(r.meta.trimmed, true);
});

test('list_arcs full:true returns untrimmed list', async () => {
  const arcs = Array.from({ length: 60 }, (_, i) => makeArc(i));
  const tool = createListArcsTool({ db: makeDb(arcs) });
  const r = await tool.handler({ limit: 20, full: true });
  assert.equal(r.arcs.length, 60);
  assert.equal(r.meta.trimmed, false);
});

test('list_arcs sorts most-recent-first by last_activity_at', async () => {
  const arcs = [
    {
      ...makeArc(1),
      last_activity_at: '2026-01-10T00:00:00.000Z',
    },
    {
      ...makeArc(2),
      last_activity_at: '2026-02-10T00:00:00.000Z',
    },
    {
      ...makeArc(3),
      last_activity_at: '2025-12-10T00:00:00.000Z',
    },
  ];
  const tool = createListArcsTool({ db: makeDb(arcs) });
  const r = await tool.handler({});
  assert.equal(r.arcs[0].name, 'Arc 2');
  assert.equal(r.arcs[1].name, 'Arc 1');
  assert.equal(r.arcs[2].name, 'Arc 3');
});
