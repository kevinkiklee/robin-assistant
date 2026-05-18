// Snapshot test for list_episodes: validates formatJournal helper wiring.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createListEpisodesTool } from '../../io/mcp/tools/list-episodes.js';

function makeDb({ episodes, eventCount = 1 }) {
  // First .query() call returns the episodes rows. Subsequent ones return the
  // grouped count. We track which call this is via a closure counter.
  let n = 0;
  return {
    query() {
      n++;
      return {
        async collect() {
          if (n === 1) return [episodes];
          return [[{ n: eventCount }]];
        },
      };
    },
  };
}

function makeEp(i) {
  return {
    id: `episodes:ep${i}`,
    started_at: new Date(2026, 0, i + 1).toISOString(),
    ended_at: null,
    source: 'cli',
    summary: `episode ${i}`,
  };
}

test('list_episodes trims to limit with formatJournal meta', async () => {
  const eps = Array.from({ length: 50 }, (_, i) => makeEp(i));
  const tool = createListEpisodesTool({ db: makeDb({ episodes: eps }) });
  const r = await tool.handler({ limit: 20 });
  assert.equal(r.episodes.length, 20);
  assert.equal(r.meta.total, 50);
  assert.equal(r.meta.shown, 20);
  assert.equal(r.meta.trimmed, true);
});

test('list_episodes full:true returns untrimmed', async () => {
  const eps = Array.from({ length: 30 }, (_, i) => makeEp(i));
  const tool = createListEpisodesTool({ db: makeDb({ episodes: eps }) });
  const r = await tool.handler({ limit: 10, full: true });
  assert.equal(r.episodes.length, 30);
  assert.equal(r.meta.trimmed, false);
});

test('list_episodes preserves existing keys (id, source, event_count)', async () => {
  const eps = [makeEp(1), makeEp(2)];
  const tool = createListEpisodesTool({ db: makeDb({ episodes: eps, eventCount: 7 }) });
  const r = await tool.handler({});
  assert.equal(r.episodes.length, 2);
  for (const ep of r.episodes) {
    assert.ok(ep.id);
    assert.equal(ep.source, 'cli');
    assert.equal(ep.event_count, 7);
  }
});
