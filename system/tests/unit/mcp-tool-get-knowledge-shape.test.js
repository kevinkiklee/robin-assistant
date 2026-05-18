// Snapshot test for get_knowledge: validates formatKnowledge helper wiring.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGetKnowledgeTool } from '../../io/mcp/tools/get-knowledge.js';

function makeKnow(i, { related = [], events = [] } = {}) {
  return {
    id: `knowledge:k${i}`,
    title: `Knowledge ${i}`,
    kind: 'fact',
    content: `body content ${i}`,
    confidence: 0.9,
    subject_id: `entities:s${i}`,
    created_at: '2026-01-01T00:00:00.000Z',
    related_entities: related,
    events,
  };
}

function makeDb(rows) {
  return {
    query() {
      return {
        async collect() {
          return [rows];
        },
      };
    },
  };
}

const embedder = {
  async embed() {
    return new Float32Array(1024);
  },
};

test('get_knowledge listKnowledge path wraps each row with formatKnowledge', async () => {
  const rows = [
    makeKnow(1, {
      related: Array.from({ length: 15 }, (_, i) => `entities:r${i}`),
      events: Array.from({ length: 8 }, (_, i) => `events:e${i}`),
    }),
  ];
  const tool = createGetKnowledgeTool({ db: makeDb(rows), embedder });
  const r = await tool.handler({});
  assert.equal(r.knowledge.length, 1);
  const item = r.knowledge[0];
  assert.equal(item.header.id, 'knowledge:k1');
  assert.equal(item.header.title, 'Knowledge 1');
  assert.equal(item.header.kind, 'fact');
  assert.equal(item.body, 'body content 1');
  assert.equal(item.related_entities.length, 10);
  assert.equal(item.recent_events.length, 5);
  assert.equal(item.meta.trimmed, true);
});

test('get_knowledge full:true returns untrimmed lists per item', async () => {
  const rows = [
    makeKnow(1, {
      related: Array.from({ length: 15 }, (_, i) => `entities:r${i}`),
      events: Array.from({ length: 8 }, (_, i) => `events:e${i}`),
    }),
  ];
  const tool = createGetKnowledgeTool({ db: makeDb(rows), embedder });
  const r = await tool.handler({ full: true });
  const item = r.knowledge[0];
  assert.equal(item.related_entities.length, 15);
  assert.equal(item.recent_events.length, 8);
  assert.equal(item.meta.trimmed, false);
});

test('get_knowledge handles empty result set', async () => {
  const tool = createGetKnowledgeTool({ db: makeDb([]), embedder });
  const r = await tool.handler({});
  assert.deepEqual(r.knowledge, []);
});
