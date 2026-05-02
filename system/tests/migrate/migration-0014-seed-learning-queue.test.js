import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { up, id, description } from '../../migrations/0014-seed-learning-queue.js';

function workspace(initial) {
  const dir = mkdtempSync(join(tmpdir(), 'mig0014-'));
  mkdirSync(join(dir, 'user-data/memory/self-improvement'), { recursive: true });
  writeFileSync(join(dir, 'user-data/memory/self-improvement/learning-queue.md'), initial);
  return dir;
}

test('migration metadata is correct', () => {
  assert.equal(id, '0014-seed-learning-queue');
  assert.match(description, /learning queue/i);
});

test('seeds questions when file has only frontmatter + intro', async () => {
  const ws = workspace(`---
description: Learning Queue
type: topic
---

# Learning Queue

Things Robin wants to understand better about the user.
`);
  await up({ workspaceDir: ws });
  const out = readFileSync(join(ws, 'user-data/memory/self-improvement/learning-queue.md'), 'utf8');
  const entries = out.match(/^### /gm) ?? [];
  assert.ok(entries.length >= 3, `expected ≥3 ### entries, got ${entries.length}`);
});

test('idempotent: no-op when file already has entries', async () => {
  const ws = workspace(`---
description: Learning Queue
type: topic
---

# Learning Queue

### 2026-04-25 — Existing question
- domain: test
- status: open
`);
  const before = readFileSync(join(ws, 'user-data/memory/self-improvement/learning-queue.md'), 'utf8');
  await up({ workspaceDir: ws });
  const after = readFileSync(join(ws, 'user-data/memory/self-improvement/learning-queue.md'), 'utf8');
  assert.equal(after, before);
});

test('idempotent: re-running after seed is a no-op', async () => {
  const ws = workspace(`---
description: Learning Queue
type: topic
---

# Learning Queue
`);
  await up({ workspaceDir: ws });
  const afterFirst = readFileSync(join(ws, 'user-data/memory/self-improvement/learning-queue.md'), 'utf8');
  await up({ workspaceDir: ws });
  const afterSecond = readFileSync(join(ws, 'user-data/memory/self-improvement/learning-queue.md'), 'utf8');
  assert.equal(afterSecond, afterFirst);
});
