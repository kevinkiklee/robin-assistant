import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { appendLogEntry, groupBySlug, readLog } from './log.ts';
import type { LogRow } from './types.ts';

function row(slug: string, ts: string, action: LogRow['action'] = 'overwrite'): LogRow {
  return {
    ts,
    action,
    slug,
    url: `https://example.test/p/${slug}`,
    user_id: 'u1',
    source: '/tmp/x.md',
    blob_key: `users/u1/pages/${slug}/index.html`,
    title: slug,
    assets: [],
    warnings: [],
  };
}

test('appendLogEntry + readLog: round-trips JSONL', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'robin-publog-'));
  const path = join(dir, 'sub', 'index.jsonl');
  await appendLogEntry(path, row('a', '2026-01-01T00:00:00.000Z'));
  await appendLogEntry(path, row('b', '2026-01-02T00:00:00.000Z'));
  const { entries, skipped } = await readLog(path);
  assert.equal(skipped, 0);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].slug, 'a');
  assert.equal(entries[1].slug, 'b');
});

test('readLog: missing file returns empty', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'robin-publog-missing-'));
  const { entries, skipped } = await readLog(join(dir, 'never-created.jsonl'));
  assert.equal(entries.length, 0);
  assert.equal(skipped, 0);
});

test('readLog: malformed lines are counted but skipped', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'robin-publog-bad-'));
  const path = join(dir, 'index.jsonl');
  await appendLogEntry(path, row('a', '2026-01-01T00:00:00.000Z'));
  // Append two bad lines via fs.writeFile via the same helper (encoded as raw):
  const { appendFile } = await import('node:fs/promises');
  await appendFile(path, '{not json\n');
  await appendFile(path, 'also not json\n');
  await appendLogEntry(path, row('b', '2026-01-02T00:00:00.000Z'));
  const { entries, skipped } = await readLog(path);
  assert.equal(entries.length, 2);
  assert.equal(skipped, 2);
  // Sanity-check the file actually has 4 lines
  const raw = readFileSync(path, 'utf8');
  assert.equal(raw.split('\n').filter(Boolean).length, 4);
});

test('groupBySlug: aggregates count and latest action per slug', () => {
  const entries: LogRow[] = [
    row('a', '2026-01-01T00:00:00.000Z', 'overwrite'),
    row('a', '2026-01-02T00:00:00.000Z', 'append'),
    row('b', '2026-01-03T00:00:00.000Z', 'overwrite'),
  ];
  const grouped = groupBySlug(entries);
  const a = grouped.find((g) => g.slug === 'a');
  const b = grouped.find((g) => g.slug === 'b');
  assert.equal(a?.count, 2);
  assert.equal(a?.lastAction, 'append');
  assert.equal(b?.count, 1);
});
