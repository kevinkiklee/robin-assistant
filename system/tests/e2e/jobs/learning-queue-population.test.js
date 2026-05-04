// E2E scenario: Dream's population phase ingests `[?|origin=user]` items
// from inbox.md and turns them into queue entries with auto-generated qids.
//
// Dream itself is agent-driven (an LLM follows system/jobs/learning-queue.md);
// this test exercises the deterministic primitives Dream uses, simulating the
// Population step for two known candidates. A real Dream run would also use
// LLM judgment to filter; here we verify the helper-side mechanics produce a
// correct queue file given selected candidates.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadQueue, qidFromHeading } from '../../../scripts/lib/learning-queue.js';

function workspace(initialQueue, initialInbox) {
  const dir = mkdtempSync(join(tmpdir(), 'lq-pop-'));
  mkdirSync(join(dir, 'bin'), { recursive: true });
  writeFileSync(join(dir, 'bin/robin.js'), '#!/usr/bin/env node\n');
  mkdirSync(join(dir, 'user-data/memory/self-improvement'), { recursive: true });
  mkdirSync(join(dir, 'user-data/memory/streams'), { recursive: true });
  if (initialQueue !== undefined) {
    writeFileSync(join(dir, 'user-data/memory/self-improvement/learning-queue.md'), initialQueue);
  }
  if (initialInbox !== undefined) {
    writeFileSync(join(dir, 'user-data/memory/streams/inbox.md'), initialInbox);
  }
  return dir;
}

// Dream's Population step (simulated): for each candidate gap, append a new
// `### YYYY-MM-DD — Title` block with the helper-derived qid. Atomic write.
function appendQuestionBlock(workspaceDir, today, title, { domain, why }) {
  const path = join(workspaceDir, 'user-data/memory/self-improvement/learning-queue.md');
  const existing = loadQueue(workspaceDir);
  const existingQids = new Set(existing.map((e) => e.qid).filter(Boolean));
  const heading = `${today} — ${title}`;
  const qid = qidFromHeading(heading, existingQids);
  const block = [
    '',
    `### ${heading}`,
    `- qid: ${qid}`,
    `- domain: ${domain}`,
    `- why: ${why}`,
    '- status: open',
    `- added: ${today}`,
    '',
  ].join('\n');
  const current = readFileSync(path, 'utf8');
  const sep = current.endsWith('\n') ? '' : '\n';
  writeFileSync(path, current + sep + block);
  return qid;
}

const SEED_QUEUE = `---
description: Learning Queue
type: topic
---

# Learning Queue
`;

const INBOX_WITH_CANDIDATES = `# Inbox

[?|origin=user] Best work time of day?
[?|origin=user] Tolerance for autonomous decisions?
`;

describe('e2e: jobs: learning-queue population', () => {
  it('two `[?|origin=user]` items become two new entries with unique qids', () => {
    const ws = workspace(SEED_QUEUE, INBOX_WITH_CANDIDATES);
    const today = '2026-05-03';
    const q1 = appendQuestionBlock(ws, today, 'Best work time of day', {
      domain: 'scheduling',
      why: 'tailor when to surface focus-heavy items',
    });
    const q2 = appendQuestionBlock(ws, today, 'Tolerance for autonomous decisions', {
      domain: 'ask-vs-act',
      why: 'calibrate the operational rule',
    });

    const queue = loadQueue(ws);
    assert.equal(queue.length, 2);
    assert.equal(queue[0].qid, q1);
    assert.equal(queue[0].status, 'open');
    assert.equal(queue[0].added, today);
    assert.equal(queue[1].qid, q2);
    assert.notEqual(q1, q2);
  });

  it('qid collision on duplicate-titled candidates appends 2-char suffix', () => {
    const ws = workspace(SEED_QUEUE);
    const today = '2026-05-03';
    const q1 = appendQuestionBlock(ws, today, 'Same title', {
      domain: 'a',
      why: 'first',
    });
    const q2 = appendQuestionBlock(ws, today, 'Same title', {
      domain: 'b',
      why: 'second',
    });
    assert.notEqual(q1, q2);
    assert.equal(q1, '2026-05-03-same-title');
    assert.match(q2, /^2026-05-03-same-title-[0-9a-z]{2}$/);
  });
});
