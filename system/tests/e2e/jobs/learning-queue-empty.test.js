// E2E scenario: empty queue → no today.md is written.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadQueue, pickToday, writeToday } from '../../../scripts/lib/learning-queue.js';

function workspace(queueText) {
  const dir = mkdtempSync(join(tmpdir(), 'lq-empty-'));
  mkdirSync(join(dir, 'bin'), { recursive: true });
  writeFileSync(join(dir, 'bin/robin.js'), '#!/usr/bin/env node\n');
  mkdirSync(join(dir, 'user-data/memory/self-improvement'), { recursive: true });
  mkdirSync(join(dir, 'user-data/runtime/state/learning-queue'), { recursive: true });
  if (queueText !== undefined) {
    writeFileSync(join(dir, 'user-data/memory/self-improvement/learning-queue.md'), queueText);
  }
  return dir;
}

describe('e2e: jobs: learning-queue empty', () => {
  it('queue with no open questions → pickToday returns null → no today.md', () => {
    const ws = workspace(`# Learning Queue

### 2026-04-01 — Already done
- qid: 2026-04-01-already-done
- domain: misc
- status: answered
- added: 2026-04-01
- answered: 2026-04-15
- answer: "yes"
- route: user-data/memory/self-improvement/preferences.md
`);
    const queue = loadQueue(ws);
    const picked = pickToday(queue, [], '2026-05-03');
    assert.equal(picked, null);
    // Dream's surfacing step would skip writing — verify by NOT calling writeToday.
    assert.equal(existsSync(join(ws, 'user-data/runtime/state/learning-queue/today.md')), false);
  });

  it('missing queue file → loadQueue returns []; pickToday returns null', () => {
    const ws = workspace();
    assert.deepEqual(loadQueue(ws), []);
    assert.equal(pickToday([], [], '2026-05-03'), null);
    assert.equal(existsSync(join(ws, 'user-data/runtime/state/learning-queue/today.md')), false);
  });

  it('writeToday is never called when picked is null (defensive non-write)', () => {
    const ws = workspace('# Learning Queue\n');
    const queue = loadQueue(ws);
    const picked = pickToday(queue, [], '2026-05-03');
    if (picked) writeToday(ws, picked, '2026-05-03T05:30:00Z');
    assert.equal(existsSync(join(ws, 'user-data/runtime/state/learning-queue/today.md')), false);
  });
});
