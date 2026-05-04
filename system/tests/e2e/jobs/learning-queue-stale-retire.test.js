// E2E scenario: questions added 61+ days ago that are still open get
// flipped to status: dropped with dropped_reason: "stale, never answered".

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadQueue, retireStale } from '../../../scripts/lib/learning-queue.js';

function workspace(queueText) {
  const dir = mkdtempSync(join(tmpdir(), 'lq-stale-'));
  mkdirSync(join(dir, 'bin'), { recursive: true });
  writeFileSync(join(dir, 'bin/robin.js'), '#!/usr/bin/env node\n');
  mkdirSync(join(dir, 'user-data/memory/self-improvement'), { recursive: true });
  writeFileSync(join(dir, 'user-data/memory/self-improvement/learning-queue.md'), queueText);
  return dir;
}

describe('e2e: jobs: learning-queue stale retire', () => {
  it('open question added 61 days ago → flipped to dropped', () => {
    // Today: 2026-07-01. q1 added 2026-04-30 (62 days). q2 added 2026-06-15 (16 days).
    const ws = workspace(`# Learning Queue

### 2026-04-30 — Old open
- qid: 2026-04-30-old-open
- domain: misc
- why: stale candidate
- status: open
- added: 2026-04-30

### 2026-06-15 — Fresh open
- qid: 2026-06-15-fresh-open
- domain: misc
- why: still active
- status: open
- added: 2026-06-15
`);
    const count = retireStale(ws, 60, '2026-07-01');
    assert.equal(count, 1);

    const queue = loadQueue(ws);
    const old = queue.find((q) => q.qid === '2026-04-30-old-open');
    const fresh = queue.find((q) => q.qid === '2026-06-15-fresh-open');
    assert.equal(old.status, 'dropped');
    assert.equal(old.dropped, '2026-07-01');
    assert.equal(old.dropped_reason, 'stale, never answered');
    assert.equal(fresh.status, 'open');
  });

  it('already-answered or already-dropped entries are not re-retired', () => {
    const ws = workspace(`# Learning Queue

### 2026-04-30 — Long answered
- qid: 2026-04-30-long-answered
- domain: misc
- why: history
- status: answered
- added: 2026-04-30
- answered: 2026-05-01
- answer: "x"
- route: user-data/memory/self-improvement/preferences.md

### 2026-04-30 — Long dropped
- qid: 2026-04-30-long-dropped
- domain: misc
- why: history
- status: dropped
- added: 2026-04-30
- dropped: 2026-05-01
- dropped_reason: "manual drop"
`);
    const count = retireStale(ws, 60, '2026-07-01');
    assert.equal(count, 0);
  });
});
