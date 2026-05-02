import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atomicWrite, openItem, writeTable } from '../../scripts/sync/lib/markdown.js';

function setup() {
  return mkdtempSync(join(tmpdir(), 'markdown-'));
}

test('atomicWrite creates parent directories', async () => {
  const ws = setup();
  await atomicWrite(ws, 'user-data/memory/knowledge/foo/bar.md', '# hi');
  assert.ok(existsSync(join(ws, 'user-data/memory/knowledge/foo/bar.md')));
  rmSync(ws, { recursive: true });
});

test('atomicWrite leaves no .tmp file behind', async () => {
  const ws = setup();
  await atomicWrite(ws, 'user-data/memory/foo.md', 'content');
  assert.ok(!existsSync(join(ws, 'user-data/memory/foo.md.tmp')));
  rmSync(ws, { recursive: true });
});

test('atomicWrite redacts content for paths under user-data/memory/', async () => {
  const ws = setup();
  await atomicWrite(ws, 'user-data/memory/x.md', 'SSN 123-45-6789 here');
  const content = readFileSync(join(ws, 'user-data/memory/x.md'), 'utf-8');
  assert.match(content, /\[REDACTED:ssn\]/);
  assert.match(content, /<!-- redaction: 1 matches blocked -->/);
  rmSync(ws, { recursive: true });
});

test('atomicWrite skips redaction for paths outside user-data/memory/', async () => {
  const ws = setup();
  await atomicWrite(ws, 'user-data/state/foo.md', 'SSN 123-45-6789 here');
  const content = readFileSync(join(ws, 'user-data/state/foo.md'), 'utf-8');
  assert.equal(content, 'SSN 123-45-6789 here');
  rmSync(ws, { recursive: true });
});

test('openItem invokes fetcher and writes when file is missing', async () => {
  const ws = setup();
  let calls = 0;
  const result = await openItem(
    ws,
    'user-data/memory/knowledge/foo/item-1.md',
    async () => {
      calls += 1;
      return 'fetched body';
    }
  );
  assert.equal(calls, 1);
  assert.equal(result, 'fetched body');
  assert.ok(existsSync(join(ws, 'user-data/memory/knowledge/foo/item-1.md')));
  rmSync(ws, { recursive: true });
});

test('openItem returns existing content without calling fetcher when file exists', async () => {
  const ws = setup();
  let calls = 0;
  const path = 'user-data/memory/knowledge/foo/item-2.md';
  await atomicWrite(ws, path, 'cached body');
  const result = await openItem(ws, path, async () => {
    calls += 1;
    return 'fetcher should not run';
  });
  assert.equal(calls, 0);
  assert.equal(result, 'cached body');
  rmSync(ws, { recursive: true });
});

test('openItem with maxAgeMs re-fetches when cached file is older than the threshold', async () => {
  const ws = setup();
  const path = 'user-data/memory/knowledge/foo/item-3.md';
  await atomicWrite(ws, path, 'old body');
  // Make the file appear old by backdating its mtime.
  const { utimesSync } = await import('node:fs');
  const oldTime = new Date(Date.now() - 60_000); // 60s ago
  utimesSync(join(ws, path), oldTime, oldTime);

  let calls = 0;
  const result = await openItem(
    ws,
    path,
    async () => {
      calls += 1;
      return 'fresh body';
    },
    { maxAgeMs: 30_000 } // 30s — file is 60s old → stale
  );
  assert.equal(calls, 1);
  assert.equal(result, 'fresh body');
  rmSync(ws, { recursive: true });
});

test('openItem with maxAgeMs uses cache when file is newer than the threshold', async () => {
  const ws = setup();
  const path = 'user-data/memory/knowledge/foo/item-4.md';
  await atomicWrite(ws, path, 'fresh-cached body');

  let calls = 0;
  const result = await openItem(
    ws,
    path,
    async () => {
      calls += 1;
      return 'should not run';
    },
    { maxAgeMs: 60_000 } // 60s — file just written → not stale
  );
  assert.equal(calls, 0);
  assert.equal(result, 'fresh-cached body');
  rmSync(ws, { recursive: true });
});

test('writeTable formats columns and rows with pipe escapes', () => {
  const md = writeTable({
    columns: ['date', 'amount', 'note'],
    rows: [
      { date: '2026-04-28', amount: '$10.00', note: 'a | b' },
      { date: '2026-04-29', amount: '$20.00', note: 'newline\nbreak' },
    ],
  });
  assert.match(md, /\| date \| amount \| note \|/);
  assert.match(md, /\| 2026-04-28 \| \$10.00 \| a \\\| b \|/);
  assert.match(md, /\| 2026-04-29 \| \$20.00 \| newline break \|/);
});
