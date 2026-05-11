import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildBiographerBatchPrompt } from '../../cognition/biographer/batch-prompt.js';

test('returns system + user messages with cache control on catalog', () => {
  const r = buildBiographerBatchPrompt({
    events: [
      { id: 'events:a', source: 'cli', content: 'Met Alice.', ts: '2026-05-09T12:00:00Z' },
      { id: 'events:b', source: 'cli', content: 'Discussed Atlas.', ts: '2026-05-09T12:01:00Z' },
    ],
    catalog: [{ name: 'Alice', type: 'person' }],
    activeEpisode: null,
  });
  assert.ok(Array.isArray(r.system));
  assert.equal(r.system.length, 2);
  assert.deepEqual(r.system[0].cache_control, { type: 'ephemeral' });
  assert.deepEqual(r.system[1].cache_control, { type: 'ephemeral' });
  assert.equal(r.messages.length, 1);
  assert.match(r.messages[0].content, /events:a/);
  assert.match(r.messages[0].content, /events:b/);
});

test('system prompt declares events[] input + per-event output indexing', () => {
  const r = buildBiographerBatchPrompt({
    events: [{ id: 'events:1', source: 'cli', content: 'x', ts: '2026-05-09T12:00:00Z' }],
    catalog: [],
    activeEpisode: null,
  });
  const sys = r.system[0].content;
  assert.match(sys, /events\[\]/);
  assert.match(sys, /event_id/);
  assert.match(sys, /one object per input event/i);
  assert.match(sys, /episode_continues_previous/);
});

test('truncates event content above 2000 chars (safety belt)', () => {
  const longContent = 'x'.repeat(3000);
  const r = buildBiographerBatchPrompt({
    events: [{ id: 'events:big', source: 'cli', content: longContent, ts: '2026-05-09T12:00:00Z' }],
    catalog: [],
    activeEpisode: null,
  });
  const userMsg = r.messages[0].content;
  assert.equal(userMsg.includes('x'.repeat(2001)), false);
  assert.equal(userMsg.includes('x'.repeat(2000)), true);
});

test('activeEpisode appears in user message but not in system blocks', () => {
  const r = buildBiographerBatchPrompt({
    events: [{ id: 'events:1', source: 'cli', content: 'q', ts: '2026-05-09T12:00:00Z' }],
    catalog: [],
    activeEpisode: { id: 'episodes:1', summary: 'Atlas planning' },
  });
  for (const m of r.system) {
    assert.doesNotMatch(m.content, /Atlas planning/);
  }
  assert.match(r.messages[0].content, /Atlas planning/);
});

test('source line in user message uses first event source (batches are source-scoped)', () => {
  const r = buildBiographerBatchPrompt({
    events: [{ id: 'events:1', source: 'discord', content: 'q', ts: '2026-05-09T12:00:00Z' }],
    catalog: [],
    activeEpisode: null,
  });
  assert.match(r.messages[0].content, /source=discord/);
});

test('catalog message groups entities by type', () => {
  const r = buildBiographerBatchPrompt({
    events: [{ id: 'events:1', source: 'cli', content: 'q', ts: '2026-05-09T12:00:00Z' }],
    catalog: [
      { name: 'Alice', type: 'person' },
      { name: 'Bob', type: 'person' },
      { name: 'Atlas', type: 'project' },
    ],
    activeEpisode: null,
  });
  const catalogMsg = r.system[1].content;
  assert.match(catalogMsg, /person/);
  assert.match(catalogMsg, /Alice/);
  assert.match(catalogMsg, /Bob/);
  assert.match(catalogMsg, /Atlas/);
});
