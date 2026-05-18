import test from 'node:test';
import assert from 'node:assert';
import { formatArc } from '../../io/format/arc.js';

test('formatArc returns header + summary + footer structure', () => {
  const raw = {
    id: 'arcs:a1',
    name: 'photography habit',
    started_at: '2026-04-01',
    summary: 'Active 90 days...',
    linked_entities: Array.from({ length: 20 }, (_, i) => ({ id: i })),
    events: Array.from({ length: 30 }, (_, i) => ({ id: i })),
  };
  const out = formatArc(raw);
  assert.strictEqual(out.header.id, 'arcs:a1');
  assert.strictEqual(out.header.total_entities, 20);
  assert.strictEqual(out.linked_entities.length, 10);
  assert.strictEqual(out.recent_events.length, 10);
  assert.strictEqual(out.meta.trimmed, true);
});

test('formatArc with full:true returns untrimmed', () => {
  const raw = {
    id: 'arcs:a1',
    linked_entities: Array.from({ length: 20 }, (_, i) => ({ id: i })),
    events: Array.from({ length: 30 }, (_, i) => ({ id: i })),
  };
  const out = formatArc(raw, { full: true });
  assert.strictEqual(out.linked_entities.length, 20);
  assert.strictEqual(out.recent_events.length, 30);
});
