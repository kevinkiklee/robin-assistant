// Tests for migration 0027 — backfill `- qid:` lines on learning-queue entries.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { up, id, description } from '../../migrations/0027-add-qids-to-learning-queue.js';

function workspace(initial) {
  const dir = mkdtempSync(join(tmpdir(), 'mig0027-'));
  mkdirSync(join(dir, 'user-data/memory/self-improvement'), { recursive: true });
  if (initial !== undefined) {
    writeFileSync(join(dir, 'user-data/memory/self-improvement/learning-queue.md'), initial);
  }
  return dir;
}

function readQueue(ws) {
  return readFileSync(join(ws, 'user-data/memory/self-improvement/learning-queue.md'), 'utf8');
}

const SEEDED = `---
description: Learning Queue
type: topic
---

# Learning Queue

### 2026-04-30 — Best work time of day
- domain: scheduling
- why: tailor when to surface focus-heavy items
- status: open

### 2026-04-30 — Detail level for finance >$1k
- domain: stress-test
- why: hard rule says stress-test these
- status: open
`;

test('migration metadata is correct', () => {
  assert.equal(id, '0027-add-qids-to-learning-queue');
  assert.match(description, /qid/i);
});

test('no-op when file is missing', async () => {
  const ws = workspace();
  await up({ workspaceDir: ws }); // should not throw
});

test('inserts qid as first bullet under each heading', async () => {
  const ws = workspace(SEEDED);
  await up({ workspaceDir: ws });
  const out = readQueue(ws);
  assert.match(
    out,
    /### 2026-04-30 — Best work time of day\n- qid: 2026-04-30-best-work-time-of-day\n- domain: scheduling/
  );
  assert.match(
    out,
    /### 2026-04-30 — Detail level for finance >\$1k\n- qid: 2026-04-30-detail-level-for-finance-1k/
  );
});

test('idempotent: skips entries that already have a qid', async () => {
  const partially = `### 2026-04-30 — Already migrated
- qid: 2026-04-30-already-migrated
- domain: x
- status: open

### 2026-04-30 — Needs qid
- domain: y
- status: open
`;
  const ws = workspace(partially);
  await up({ workspaceDir: ws });
  const out = readQueue(ws);
  // Existing qid not duplicated.
  assert.equal(out.match(/qid: 2026-04-30-already-migrated/g).length, 1);
  // New qid added for the second entry.
  assert.match(out, /qid: 2026-04-30-needs-qid/);
});

test('idempotent: re-running is a no-op', async () => {
  const ws = workspace(SEEDED);
  await up({ workspaceDir: ws });
  const afterFirst = readQueue(ws);
  await up({ workspaceDir: ws });
  const afterSecond = readQueue(ws);
  assert.equal(afterSecond, afterFirst);
});

test('preserves all other content (ordering + frontmatter + intro)', async () => {
  const ws = workspace(SEEDED);
  await up({ workspaceDir: ws });
  const out = readQueue(ws);
  assert.match(out, /^---\ndescription: Learning Queue/);
  assert.match(out, /# Learning Queue/);
  // The two entries appear in the same order.
  const idxFirst = out.indexOf('Best work time of day');
  const idxSecond = out.indexOf('Detail level for finance');
  assert.ok(idxFirst < idxSecond);
});

test('handles colliding titles by appending a 2-char suffix', async () => {
  const dup = `### 2026-04-30 — Same title
- domain: a
- status: open

### 2026-04-30 — Same title
- domain: b
- status: open
`;
  const ws = workspace(dup);
  await up({ workspaceDir: ws });
  const out = readQueue(ws);
  const qids = [...out.matchAll(/^- qid: (\S+)/gm)].map((m) => m[1]);
  assert.equal(qids.length, 2);
  assert.notEqual(qids[0], qids[1]);
  assert.equal(qids[0], '2026-04-30-same-title');
  assert.match(qids[1], /^2026-04-30-same-title-[0-9a-z]{2}$/);
});
