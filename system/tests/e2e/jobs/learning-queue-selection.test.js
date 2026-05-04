// E2E scenario: Dream's selection phase picks today's question by score.
// 3 open questions + recent captures matching one domain → that question
// becomes today.md.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadQueue, pickToday, writeToday, readToday } from '../../../scripts/lib/learning-queue.js';

function workspace(queueText) {
  const dir = mkdtempSync(join(tmpdir(), 'lq-sel-'));
  mkdirSync(join(dir, 'bin'), { recursive: true });
  writeFileSync(join(dir, 'bin/robin.js'), '#!/usr/bin/env node\n');
  mkdirSync(join(dir, 'user-data/memory/self-improvement'), { recursive: true });
  mkdirSync(join(dir, 'user-data/runtime/state/learning-queue'), { recursive: true });
  writeFileSync(join(dir, 'user-data/memory/self-improvement/learning-queue.md'), queueText);
  return dir;
}

const QUEUE = `# Learning Queue

### 2026-04-30 — Best work time of day
- qid: 2026-04-30-best-work-time-of-day
- domain: scheduling
- why: tailor when to surface focus-heavy items
- status: open
- added: 2026-04-30

### 2026-04-30 — Detail level for finance >$1k
- qid: 2026-04-30-detail-level-for-finance-1k
- domain: stress-test
- why: hard rule says stress-test these
- status: open
- added: 2026-04-30

### 2026-04-30 — Tolerance for predictions
- qid: 2026-04-30-tolerance-for-predictions
- domain: outcome-learning
- why: gates outcome-check
- status: open
- added: 2026-04-30
`;

describe('e2e: jobs: learning-queue selection', () => {
  it('captures matching one domain promote that question to today.md', () => {
    const ws = workspace(QUEUE);
    const queue = loadQueue(ws);
    const captures = [
      { domain: 'stress-test', text: 'thinking about a $5k purchase' },
      { domain: 'stress-test', text: 'rebalancing portfolio this week' },
    ];
    const picked = pickToday(queue, captures, '2026-05-03');
    assert.equal(picked.qid, '2026-04-30-detail-level-for-finance-1k');

    writeToday(ws, { ...picked, original_tag: 'preference' }, '2026-05-03T05:30:00Z');
    const today = readToday(ws);
    assert.equal(today.qid, '2026-04-30-detail-level-for-finance-1k');
    assert.equal(today.domain, 'stress-test');
    assert.match(today.body, /\[answer\|qid=2026-04-30-detail-level-for-finance-1k\|preference\|origin=user\]/);
    assert.ok(existsSync(join(ws, 'user-data/runtime/state/learning-queue/today.md')));
  });

  it('falls back to oldest open when no captures match any domain', () => {
    const ws = workspace(QUEUE);
    const queue = loadQueue(ws);
    const picked = pickToday(queue, [], '2026-05-03');
    // All three added on same date → qid lexical tiebreaker
    // qids start with same date prefix; lexical sort: best-work < detail < tolerance
    assert.equal(picked.qid, '2026-04-30-best-work-time-of-day');
  });

  it('keyword-overlap captures still pick the relevant question', () => {
    const ws = workspace(QUEUE);
    const queue = loadQueue(ws);
    const captures = [
      // text shares "tolerance" + "predictions" with q3 question text
      // (≥2 non-stopword token overlap) → +1 for q3, beats lexical-tiebreak baseline
      { domain: 'unrelated', text: 'tolerance predictions matter today' },
    ];
    const picked = pickToday(queue, captures, '2026-05-03');
    assert.equal(picked.qid, '2026-04-30-tolerance-for-predictions');
  });
});
