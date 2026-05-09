import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildBiographerPrompt } from '../../src/capture/biographer-prompt.js';

test('buildBiographerPrompt returns system + user messages', () => {
  const r = buildBiographerPrompt({
    event: {
      id: 'events:1',
      source: 'cli',
      content: 'Met Alice at the cafe to discuss project Atlas.',
      ts: '2026-05-09T12:00:00Z',
    },
    catalog: [
      { name: 'Alice', type: 'person' },
      { name: 'Atlas', type: 'project' },
    ],
    activeEpisode: null,
  });
  assert.ok(Array.isArray(r.system));
  assert.ok(r.system.length >= 2);
  assert.deepEqual(r.system[0].cache_control, { type: 'ephemeral' });
  assert.deepEqual(r.system[1].cache_control, { type: 'ephemeral' });
  assert.ok(Array.isArray(r.messages));
  assert.equal(r.messages.length, 1);
  assert.match(r.messages[0].content, /Met Alice/);
});

test('catalog message includes all catalog entities grouped by type', () => {
  const r = buildBiographerPrompt({
    event: { id: 'events:2', source: 'cli', content: 'q', ts: '2026-05-09T12:00:00Z' },
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

test('activeEpisode appears in user message but not in system (uncached)', () => {
  const r = buildBiographerPrompt({
    event: { id: 'events:3', source: 'cli', content: 'follow-up', ts: '2026-05-09T12:00:00Z' },
    catalog: [],
    activeEpisode: { id: 'episodes:1', summary: 'Project Atlas planning' },
  });
  for (const m of r.system) {
    assert.doesNotMatch(m.content, /Project Atlas planning/);
  }
  assert.match(r.messages[0].content, /Project Atlas planning/);
});

test('empty catalog produces a still-valid catalog message', () => {
  const r = buildBiographerPrompt({
    event: { id: 'events:4', source: 'cli', content: 'q', ts: '2026-05-09T12:00:00Z' },
    catalog: [],
    activeEpisode: null,
  });
  assert.equal(r.system.length, 2);
  // catalog message should still exist (cacheable layer); content acknowledges no entries
  assert.ok(r.system[1].content.length > 0);
});

test('system prompt mentions output JSON schema and vocabulary', () => {
  const r = buildBiographerPrompt({
    event: { id: 'events:5', source: 'cli', content: 'q', ts: '2026-05-09T12:00:00Z' },
    catalog: [],
    activeEpisode: null,
  });
  const sys = r.system[0].content;
  assert.match(sys, /entities/);
  assert.match(sys, /edges/);
  assert.match(sys, /episode_continues_previous/);
  // Vocabulary
  assert.match(sys, /person/);
  assert.match(sys, /works_on/);
});
