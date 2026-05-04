// E2E scenario: closure of an answered question.
// today.md has a pending question; inbox.md contains a matching
// `[answer|qid=...]` line. Dream's closure step:
//   1. parses the answer marker,
//   2. flips queue entry status open → answered,
//   3. routes the answer to the destination file,
//   4. clears today.md.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadQueue,
  writeToday,
  clearToday,
  markAnswered,
  routeFromTag,
  readToday,
} from '../../../scripts/lib/learning-queue.js';

function workspace() {
  const dir = mkdtempSync(join(tmpdir(), 'lq-close-'));
  mkdirSync(join(dir, 'bin'), { recursive: true });
  writeFileSync(join(dir, 'bin/robin.js'), '#!/usr/bin/env node\n');
  mkdirSync(join(dir, 'user-data/memory/self-improvement'), { recursive: true });
  mkdirSync(join(dir, 'user-data/memory/streams'), { recursive: true });
  mkdirSync(join(dir, 'user-data/runtime/state/learning-queue'), { recursive: true });

  writeFileSync(
    join(dir, 'user-data/memory/self-improvement/learning-queue.md'),
    `# Learning Queue

### 2026-04-30 — Best work time of day
- qid: 2026-04-30-best-work-time-of-day
- domain: scheduling
- why: tailor focus surfacing
- status: open
- added: 2026-04-30
`
  );
  writeFileSync(
    join(dir, 'user-data/memory/self-improvement/preferences.md'),
    '# Preferences\n'
  );
  return dir;
}

// Simulate the closure step end-to-end for one answer marker.
// Real Dream agent would scan inbox.md; we drive the helpers explicitly.
function closeAnswer(workspaceDir, qid, tag, answerText, today) {
  const route = routeFromTag(tag);
  assert.ok(route, `expected deterministic route for tag=${tag}`);
  const ok = markAnswered(workspaceDir, qid, { answer: answerText, route, date: today });
  if (!ok) throw new Error(`markAnswered failed for ${qid}`);
  // Append to destination file (Dream picks the right subsection at runtime).
  appendFileSync(join(workspaceDir, route), `\n- ${today}: ${answerText} (from learning queue qid=${qid})\n`);
  // Clear today.md if its qid matches.
  const today_md = readToday(workspaceDir);
  if (today_md && today_md.qid === qid) clearToday(workspaceDir);
}

describe('e2e: jobs: learning-queue closure', () => {
  it('answer marker promotes question to answered and clears today.md', () => {
    const ws = workspace();
    writeToday(
      ws,
      {
        qid: '2026-04-30-best-work-time-of-day',
        question: 'Best work time of day?',
        why: 'tailor focus surfacing',
        domain: 'scheduling',
        original_tag: 'preference',
      },
      '2026-05-03T05:30:00Z'
    );
    assert.ok(existsSync(join(ws, 'user-data/runtime/state/learning-queue/today.md')));

    closeAnswer(ws, '2026-04-30-best-work-time-of-day', 'preference', 'morning, 9-11am peak', '2026-05-04');

    // Queue entry is now answered.
    const queue = loadQueue(ws);
    const entry = queue.find((q) => q.qid === '2026-04-30-best-work-time-of-day');
    assert.equal(entry.status, 'answered');
    assert.equal(entry.answered, '2026-05-04');
    assert.equal(entry.answer, 'morning, 9-11am peak');
    assert.equal(entry.route, 'user-data/memory/self-improvement/preferences.md');

    // Answer routed to preferences.md.
    const prefs = readFileSync(join(ws, 'user-data/memory/self-improvement/preferences.md'), 'utf8');
    assert.match(prefs, /morning, 9-11am peak.*qid=2026-04-30-best-work-time-of-day/);

    // today.md cleared.
    assert.equal(existsSync(join(ws, 'user-data/runtime/state/learning-queue/today.md')), false);
  });

  it('unknown qid does not crash; markAnswered returns false', () => {
    const ws = workspace();
    const ok = markAnswered(ws, 'no-such-qid', {
      answer: 'whatever',
      route: 'user-data/memory/streams/inbox.md',
      date: '2026-05-04',
    });
    assert.equal(ok, false);
  });
});
