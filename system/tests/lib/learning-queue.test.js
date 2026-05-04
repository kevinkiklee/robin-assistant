// Unit tests for system/scripts/lib/learning-queue.js helpers.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadQueue,
  qidFromHeading,
  pickToday,
  writeToday,
  readToday,
  clearToday,
  markAnswered,
  retireStale,
  routeFromTag,
} from '../../scripts/lib/learning-queue.js';

function makeWorkspace(initialQueue) {
  const dir = mkdtempSync(join(tmpdir(), 'lq-'));
  // Need to look like a robin workspace root for any helper that calls validateWorkspaceRoot.
  mkdirSync(join(dir, 'bin'), { recursive: true });
  writeFileSync(join(dir, 'bin/robin.js'), '#!/usr/bin/env node\n');
  mkdirSync(join(dir, 'user-data/memory/self-improvement'), { recursive: true });
  mkdirSync(join(dir, 'user-data/memory/streams'), { recursive: true });
  mkdirSync(join(dir, 'user-data/runtime/state/learning-queue'), { recursive: true });
  if (initialQueue !== undefined) {
    writeFileSync(join(dir, 'user-data/memory/self-improvement/learning-queue.md'), initialQueue);
  }
  return dir;
}

const SAMPLE_QUEUE = `---
description: Learning Queue
type: topic
---

# Learning Queue

Intro.

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

### 2026-04-30 — Old answered question
- qid: 2026-04-30-old-answered-question
- domain: misc
- why: history
- status: answered
- added: 2026-04-30
- answered: 2026-05-01
- answer: "yes, did the thing"
- route: user-data/memory/self-improvement/preferences.md
`;

describe('qidFromHeading', () => {
  it('builds a slug from a YYYY-MM-DD — Title heading', () => {
    const qid = qidFromHeading('2026-04-30 — Best work time of day', new Set());
    assert.equal(qid, '2026-04-30-best-work-time-of-day');
  });

  it('handles leading ### prefix gracefully', () => {
    const qid = qidFromHeading('### 2026-04-30 — Best work time of day', new Set());
    assert.equal(qid, '2026-04-30-best-work-time-of-day');
  });

  it('strips punctuation', () => {
    const qid = qidFromHeading('2026-04-30 — Detail level for finance >$1k!', new Set());
    assert.equal(qid, '2026-04-30-detail-level-for-finance-1k');
  });

  it('lowercases and slugifies', () => {
    const qid = qidFromHeading('2026-04-30 — Style: verbal-style match vs explicit', new Set());
    assert.equal(qid, '2026-04-30-style-verbal-style-match-vs-explicit');
  });

  it('appends a 2-char base36 suffix on collision', () => {
    const existing = new Set(['2026-04-30-foo']);
    const qid = qidFromHeading('2026-04-30 — Foo', existing);
    assert.notEqual(qid, '2026-04-30-foo');
    assert.match(qid, /^2026-04-30-foo-[0-9a-z]{2}$/);
  });

  it('handles ASCII em-dash hyphen separator', () => {
    // ASCII fallback: "2026-04-30 - Title" with a regular hyphen as separator
    const qid = qidFromHeading('2026-04-30 - Plain hyphen', new Set());
    assert.equal(qid, '2026-04-30-plain-hyphen');
  });

  it('returns the date-only slug when title is empty', () => {
    const qid = qidFromHeading('2026-04-30 — ', new Set());
    assert.equal(qid, '2026-04-30');
  });

  it('collision suffix is deterministic for same inputs (no collisions)', () => {
    const a = qidFromHeading('2026-04-30 — Foo', new Set(['2026-04-30-foo']));
    const b = qidFromHeading('2026-04-30 — Foo', new Set(['2026-04-30-foo']));
    assert.equal(a, b);
  });
});

describe('loadQueue', () => {
  it('parses entries with all fields', () => {
    const ws = makeWorkspace(SAMPLE_QUEUE);
    const queue = loadQueue(ws);
    assert.equal(queue.length, 3);
    const [first, second, third] = queue;
    assert.equal(first.qid, '2026-04-30-best-work-time-of-day');
    assert.equal(first.question, 'Best work time of day');
    assert.equal(first.domain, 'scheduling');
    assert.equal(first.why, 'tailor when to surface focus-heavy items');
    assert.equal(first.status, 'open');
    assert.equal(first.added, '2026-04-30');
    assert.equal(second.domain, 'stress-test');
    assert.equal(third.status, 'answered');
    assert.equal(third.answer, 'yes, did the thing');
    assert.equal(third.route, 'user-data/memory/self-improvement/preferences.md');
  });

  it('returns empty array when file does not exist', () => {
    const ws = makeWorkspace();
    assert.deepEqual(loadQueue(ws), []);
  });

  it('returns empty array when file has no entries', () => {
    const ws = makeWorkspace(`---\ntype: topic\n---\n\n# Empty\n`);
    assert.deepEqual(loadQueue(ws), []);
  });

  it('tolerates entries missing optional fields', () => {
    const ws = makeWorkspace(`# Q\n\n### 2026-04-30 — Sparse\n- qid: 2026-04-30-sparse\n- status: open\n`);
    const queue = loadQueue(ws);
    assert.equal(queue.length, 1);
    assert.equal(queue[0].domain, undefined);
    assert.equal(queue[0].why, undefined);
  });
});

describe('pickToday', () => {
  const queue = [
    { qid: 'q1', question: 'Best time to work?', domain: 'scheduling', status: 'open', added: '2026-04-30' },
    { qid: 'q2', question: 'How much detail for finance?', domain: 'stress-test', status: 'open', added: '2026-04-29' },
    { qid: 'q3', question: 'Tolerance for predictions?', domain: 'outcome-learning', status: 'open', added: '2026-04-28' },
    { qid: 'q-answered', question: 'Done', domain: 'misc', status: 'answered', added: '2026-04-30' },
  ];

  it('skips answered/dropped questions', () => {
    const picked = pickToday(queue, [], '2026-05-03');
    assert.notEqual(picked.qid, 'q-answered');
  });

  it('falls back to oldest open when no captures', () => {
    const picked = pickToday(queue, [], '2026-05-03');
    // q3 is oldest at 2026-04-28
    assert.equal(picked.qid, 'q3');
  });

  it('+2 for exact domain match', () => {
    const captures = [{ domain: 'scheduling', text: 'random text here' }];
    const picked = pickToday(queue, captures, '2026-05-03');
    assert.equal(picked.qid, 'q1');
  });

  it('+1 for keyword overlap (≥2 non-stopword tokens)', () => {
    // q1 question contains "best", "time", "work"
    const captures = [{ domain: 'unrelated', text: 'thinking about best time to work today' }];
    const picked = pickToday(queue, captures, '2026-05-03');
    assert.equal(picked.qid, 'q1');
  });

  it('domain match outranks keyword match', () => {
    const captures = [
      { domain: 'stress-test', text: 'unrelated content one' }, // +2 for q2
      { domain: 'scheduling', text: 'best time for work?' },    // +2 + maybe +1 for q1
    ];
    // q1 should win: +2 (domain) +1 (keyword overlap)
    const picked = pickToday(queue, captures, '2026-05-03');
    assert.equal(picked.qid, 'q1');
  });

  it('tiebreaker: oldest added: when scores tie', () => {
    const captures = [
      { domain: 'scheduling', text: 'aaa' },     // +2 for q1
      { domain: 'stress-test', text: 'bbb' },    // +2 for q2
    ];
    // q1 added 2026-04-30, q2 added 2026-04-29 → q2 oldest → q2 wins
    const picked = pickToday(queue, captures, '2026-05-03');
    assert.equal(picked.qid, 'q2');
  });

  it('tiebreaker: qid lexical when scores AND added: tie', () => {
    const local = [
      { qid: 'q-b', question: 'B?', domain: 'x', status: 'open', added: '2026-04-30' },
      { qid: 'q-a', question: 'A?', domain: 'x', status: 'open', added: '2026-04-30' },
    ];
    const picked = pickToday(local, [], '2026-05-03');
    assert.equal(picked.qid, 'q-a');
  });

  it('returns null when no open questions', () => {
    const picked = pickToday([{ qid: 'q', status: 'answered', added: '2026-04-30' }], [], '2026-05-03');
    assert.equal(picked, null);
  });

  it('keyword match requires ≥2 non-stopword tokens', () => {
    // Single-word match should not score
    const captures = [{ domain: 'unrelated', text: 'best' }]; // 'best' is one keyword token
    const picked = pickToday(queue, captures, '2026-05-03');
    // No score → fall back to oldest open
    assert.equal(picked.qid, 'q3');
  });
});

describe('writeToday / readToday / clearToday', () => {
  it('round-trips a question', () => {
    const ws = makeWorkspace(SAMPLE_QUEUE);
    const item = { qid: 'q1', question: 'Best time?', why: 'because', domain: 'scheduling', original_tag: 'preference' };
    writeToday(ws, item, '2026-05-03T12:00:00Z');
    const read = readToday(ws);
    assert.equal(read.qid, 'q1');
    assert.equal(read.domain, 'scheduling');
    assert.equal(read.question, 'Best time?');
    assert.match(read.body, /\[answer\|qid=q1\|preference\|origin=user\]/);
  });

  it('writeToday is atomic (tmp + rename)', () => {
    const ws = makeWorkspace(SAMPLE_QUEUE);
    writeToday(ws, { qid: 'q1', question: 'q?', why: 'w', domain: 'd', original_tag: 'fact' }, '2026-05-03T12:00:00Z');
    // No leftover .tmp files
    const dir = join(ws, 'user-data/runtime/state/learning-queue');
    const files = readFileSync(join(dir, 'today.md'), 'utf8');
    assert.match(files, /qid: q1/);
  });

  it('clearToday removes the file', () => {
    const ws = makeWorkspace(SAMPLE_QUEUE);
    writeToday(ws, { qid: 'q1', question: 'q?', why: 'w', domain: 'd', original_tag: 'fact' }, '2026-05-03T12:00:00Z');
    clearToday(ws);
    assert.equal(existsSync(join(ws, 'user-data/runtime/state/learning-queue/today.md')), false);
  });

  it('readToday returns null when file is missing', () => {
    const ws = makeWorkspace();
    assert.equal(readToday(ws), null);
  });

  it('clearToday is a no-op when file is missing', () => {
    const ws = makeWorkspace();
    clearToday(ws); // should not throw
  });
});

describe('markAnswered', () => {
  it('flips status: open → answered with new fields', () => {
    const ws = makeWorkspace(SAMPLE_QUEUE);
    const ok = markAnswered(ws, '2026-04-30-best-work-time-of-day', {
      answer: 'morning, 9-11am peak',
      route: 'user-data/memory/self-improvement/preferences.md',
      date: '2026-05-08',
    });
    assert.equal(ok, true);
    const text = readFileSync(join(ws, 'user-data/memory/self-improvement/learning-queue.md'), 'utf8');
    assert.match(text, /- status: answered\n- added: 2026-04-30\n- answered: 2026-05-08\n- answer: "morning, 9-11am peak"\n- route: user-data\/memory\/self-improvement\/preferences\.md/);
    // Other entries preserved
    assert.match(text, /qid: 2026-04-30-detail-level-for-finance-1k/);
  });

  it('returns false when qid not found', () => {
    const ws = makeWorkspace(SAMPLE_QUEUE);
    const ok = markAnswered(ws, 'no-such-qid', { answer: 'x', route: 'y', date: '2026-05-08' });
    assert.equal(ok, false);
  });

  it('does NOT modify a question that is already answered (respects manual edits)', () => {
    const ws = makeWorkspace(SAMPLE_QUEUE);
    const before = readFileSync(join(ws, 'user-data/memory/self-improvement/learning-queue.md'), 'utf8');
    const ok = markAnswered(ws, '2026-04-30-old-answered-question', {
      answer: 'should not overwrite',
      route: 'foo',
      date: '2026-05-09',
    });
    assert.equal(ok, false);
    const after = readFileSync(join(ws, 'user-data/memory/self-improvement/learning-queue.md'), 'utf8');
    assert.equal(after, before);
  });

  it('escapes quotes in answer text', () => {
    const ws = makeWorkspace(SAMPLE_QUEUE);
    markAnswered(ws, '2026-04-30-best-work-time-of-day', {
      answer: 'she said "hello"',
      route: 'user-data/memory/self-improvement/preferences.md',
      date: '2026-05-08',
    });
    const text = readFileSync(join(ws, 'user-data/memory/self-improvement/learning-queue.md'), 'utf8');
    assert.match(text, /- answer: "she said \\"hello\\""/);
  });
});

describe('retireStale', () => {
  it('flips open questions older than ageDays to dropped', () => {
    // q1 added 2026-04-30, today = 2026-07-01 → 62 days old
    const ws = makeWorkspace(SAMPLE_QUEUE);
    const count = retireStale(ws, 60, '2026-07-01');
    assert.equal(count, 2); // both open ones are stale
    const text = readFileSync(join(ws, 'user-data/memory/self-improvement/learning-queue.md'), 'utf8');
    assert.match(text, /- status: dropped\n- added: 2026-04-30\n- dropped: 2026-07-01\n- dropped_reason: "stale, never answered"/);
  });

  it('leaves fresh questions alone', () => {
    const ws = makeWorkspace(SAMPLE_QUEUE);
    const count = retireStale(ws, 60, '2026-05-15'); // 15 days from added
    assert.equal(count, 0);
  });

  it('does not touch already-answered or already-dropped questions', () => {
    const ws = makeWorkspace(SAMPLE_QUEUE);
    retireStale(ws, 60, '2026-07-01');
    const queue = loadQueue(ws);
    const answered = queue.find((q) => q.qid === '2026-04-30-old-answered-question');
    assert.equal(answered.status, 'answered');
  });

  it('returns 0 when queue is missing or empty', () => {
    const ws = makeWorkspace();
    assert.equal(retireStale(ws, 60, '2026-07-01'), 0);
  });
});

describe('routeFromTag', () => {
  it('maps preference → preferences.md', () => {
    assert.equal(routeFromTag('preference'), 'user-data/memory/self-improvement/preferences.md');
  });
  it('maps decision → decisions.md', () => {
    assert.equal(routeFromTag('decision'), 'user-data/memory/streams/decisions.md');
  });
  it('maps correction → corrections.md', () => {
    assert.equal(routeFromTag('correction'), 'user-data/memory/self-improvement/corrections.md');
  });
  it('returns null for fact (Dream picks at runtime)', () => {
    assert.equal(routeFromTag('fact'), null);
  });
  it('returns null for update (Dream picks at runtime)', () => {
    assert.equal(routeFromTag('update'), null);
  });
  it('falls back to inbox.md for unknown tags', () => {
    assert.equal(routeFromTag('weird-tag'), 'user-data/memory/streams/inbox.md');
  });
  it('handles undefined tag (defaults to inbox)', () => {
    assert.equal(routeFromTag(undefined), 'user-data/memory/streams/inbox.md');
  });
});
