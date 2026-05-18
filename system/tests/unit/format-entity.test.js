import assert from 'node:assert';
import test from 'node:test';
import { formatEntity } from '../../io/format/entity.js';

test('formatEntity trims edges + events with default limits', () => {
  const raw = {
    id: 'entities:e1',
    kind: 'person',
    name: 'Kevin',
    edges: Array.from({ length: 30 }, (_, i) => ({ id: i })),
    events: Array.from({ length: 15 }, (_, i) => ({ id: i })),
  };
  const out = formatEntity(raw);
  assert.strictEqual(out.edges.length, 20);
  assert.strictEqual(out.events.length, 10);
  assert.strictEqual(out.meta.total_edges, 30);
  assert.strictEqual(out.meta.total_events, 15);
  assert.strictEqual(out.meta.trimmed, true);
});

test('formatEntity with full:true returns untrimmed', () => {
  const raw = {
    id: 'entities:e1',
    kind: 'person',
    name: 'Kevin',
    edges: Array.from({ length: 30 }, (_, i) => ({ id: i })),
    events: Array.from({ length: 15 }, (_, i) => ({ id: i })),
  };
  const out = formatEntity(raw, { full: true });
  assert.strictEqual(out.edges.length, 30);
  assert.strictEqual(out.events.length, 15);
  assert.strictEqual(out.meta.trimmed, false);
});

test('formatEntity handles empty raw', () => {
  const out = formatEntity({});
  assert.strictEqual(out.edges.length, 0);
  assert.strictEqual(out.meta.total_edges, 0);
});
