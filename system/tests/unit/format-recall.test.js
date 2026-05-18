import assert from 'node:assert';
import test from 'node:test';
import { trimRecallEvents } from '../../io/format/recall.js';

test('keeps short events at full length', () => {
  const events = [{ content: 'hello world' }, { content: 'goodbye' }];
  const out = trimRecallEvents(events);
  assert.strictEqual(out[0].content, 'hello world');
  assert.strictEqual(out[0].truncated, false);
  assert.strictEqual(out[1].content, 'goodbye');
  assert.strictEqual(out[1].truncated, false);
});

test('truncates long events to 200 chars + ellipsis after budget exhausted', () => {
  const events = [];
  for (let i = 0; i < 10; i++) events.push({ content: 'x'.repeat(500) });
  const out = trimRecallEvents(events);
  // First 5 should be full-length (still under budget: 5×500 = 2500 < 4000)
  for (let i = 0; i < 5; i++) {
    assert.strictEqual(out[i].content.length, 500);
    assert.strictEqual(out[i].truncated, false);
  }
  // Remaining should be truncated to 200 + '…'
  for (let i = 5; i < 10; i++) {
    assert.strictEqual(out[i].content.length, 201); // 200 + ellipsis
    assert.strictEqual(out[i].truncated, true);
  }
});

test('honors caller-supplied budget overrides', () => {
  const events = [{ content: 'x'.repeat(100) }, { content: 'x'.repeat(100) }];
  const out = trimRecallEvents(events, { fullEvents: 1 });
  assert.strictEqual(out[0].truncated, false);
  // Second event is short (100 < perEventMax 200), so it's kept unsliced
  assert.strictEqual(out[1].content.length, 100);
  assert.strictEqual(out[1].truncated, false);
});
