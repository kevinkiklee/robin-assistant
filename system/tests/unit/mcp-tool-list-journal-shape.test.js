// Snapshot test for list_journal: validates formatJournal helper wiring.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createListJournalTool } from '../../io/mcp/tools/list-journal.js';

function makeEntry(i) {
  return {
    id: `events:e${i}`,
    episode_id: `episodes:ep${i}`,
    ts: new Date(2026, 0, i + 1).toISOString(),
    source: 'cli',
    content: `entry ${i}`,
  };
}

function makeDb(entries) {
  // listJournalEntries reads via select; mock returns rows.
  return {
    query() {
      return {
        async collect() {
          return [entries];
        },
      };
    },
  };
}

test('list_journal trims to limit and exposes meta.trimmed=true', async () => {
  const entries = Array.from({ length: 100 }, (_, i) => makeEntry(i));
  const tool = createListJournalTool({ db: makeDb(entries) });
  const r = await tool.handler({ limit: 50 });
  assert.equal(r.entries.length, 50);
  assert.equal(r.meta.total, 100);
  assert.equal(r.meta.shown, 50);
  assert.equal(r.meta.trimmed, true);
});

test('list_journal full:true returns untrimmed', async () => {
  const entries = Array.from({ length: 100 }, (_, i) => makeEntry(i));
  const tool = createListJournalTool({ db: makeDb(entries) });
  const r = await tool.handler({ limit: 50, full: true });
  assert.equal(r.entries.length, 100);
  assert.equal(r.meta.trimmed, false);
});

test('list_journal sorts most-recent-first', async () => {
  const entries = [
    { ...makeEntry(1), ts: '2026-01-10T00:00:00.000Z' },
    { ...makeEntry(2), ts: '2026-02-15T00:00:00.000Z' },
    { ...makeEntry(3), ts: '2025-12-31T00:00:00.000Z' },
  ];
  const tool = createListJournalTool({ db: makeDb(entries) });
  const r = await tool.handler({});
  assert.equal(r.entries[0].content, 'entry 2');
  assert.equal(r.entries[1].content, 'entry 1');
  assert.equal(r.entries[2].content, 'entry 3');
});
