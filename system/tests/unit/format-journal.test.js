import test from 'node:test';
import assert from 'node:assert';
import { formatJournal } from '../../io/format/journal.js';

test('formatJournal sorts most-recent-first by ts', () => {
  const rows = [
    { id: 1, ts: '2026-05-01T00:00:00Z' },
    { id: 2, ts: '2026-05-17T00:00:00Z' },
    { id: 3, ts: '2026-05-10T00:00:00Z' },
  ];
  const out = formatJournal(rows);
  assert.deepStrictEqual(out.items.map((r) => r.id), [2, 3, 1]);
});

test('formatJournal falls back to created_at when ts missing', () => {
  const rows = [
    { id: 1, created_at: '2026-05-01T00:00:00Z' },
    { id: 2, created_at: '2026-05-17T00:00:00Z' },
  ];
  const out = formatJournal(rows);
  assert.deepStrictEqual(out.items.map((r) => r.id), [2, 1]);
});

test('formatJournal trims to limit', () => {
  const rows = Array.from({ length: 100 }, (_, i) => ({ id: i, ts: '2026-05-17T00:00:00Z' }));
  const out = formatJournal(rows, { limit: 10 });
  assert.strictEqual(out.items.length, 10);
  assert.strictEqual(out.meta.total, 100);
  assert.strictEqual(out.meta.trimmed, true);
});
