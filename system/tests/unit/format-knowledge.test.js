import test from 'node:test';
import assert from 'node:assert';
import { formatKnowledge } from '../../io/format/knowledge.js';

test('formatKnowledge returns header + body + footer structure with trimming', () => {
  const raw = {
    id: 'knowledge:k1',
    title: 'photography habit',
    kind: 'fact',
    created_at: '2026-04-01',
    confidence: 0.9,
    content: 'Kevin shoots 3x more in 2026...',
    related_entities: Array.from({ length: 15 }, (_, i) => ({ id: i })),
    events: Array.from({ length: 12 }, (_, i) => ({ id: i })),
  };
  const out = formatKnowledge(raw);
  assert.strictEqual(out.header.id, 'knowledge:k1');
  assert.strictEqual(out.header.title, 'photography habit');
  assert.strictEqual(out.header.confidence, 0.9);
  assert.strictEqual(out.body, 'Kevin shoots 3x more in 2026...');
  assert.strictEqual(out.related_entities.length, 10);
  assert.strictEqual(out.recent_events.length, 5);
  assert.strictEqual(out.meta.total_related, 15);
  assert.strictEqual(out.meta.total_events, 12);
  assert.strictEqual(out.meta.trimmed, true);
});

test('formatKnowledge with full:true returns untrimmed', () => {
  const raw = {
    id: 'knowledge:k1',
    related_entities: Array.from({ length: 15 }, (_, i) => ({ id: i })),
    events: Array.from({ length: 12 }, (_, i) => ({ id: i })),
  };
  const out = formatKnowledge(raw, { full: true });
  assert.strictEqual(out.related_entities.length, 15);
  assert.strictEqual(out.recent_events.length, 12);
  assert.strictEqual(out.meta.trimmed, false);
});

test('formatKnowledge falls back to body when content missing', () => {
  const raw = { id: 'knowledge:k1', body: 'fallback body text' };
  const out = formatKnowledge(raw);
  assert.strictEqual(out.body, 'fallback body text');
});
