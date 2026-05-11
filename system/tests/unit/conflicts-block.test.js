import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildConflictBlock, dedupeAndCapPairs } from '../../cognition/intuition/conflicts.js';

// ---------------------------------------------------------------------------
// dedupeAndCapPairs (Task 1.3)
// ---------------------------------------------------------------------------

test('dedupeAndCapPairs: collapses self-pair returned from both LET branches', () => {
  const raw = [
    { side: 'memos:A', other: 'memos:B' },
    { side: 'memos:B', other: 'memos:A' },
  ];
  const out = dedupeAndCapPairs(raw, 24);
  assert.equal(out.pairs.length, 1);
  assert.equal(out.pairs_precap, 1);
  // First-seen orientation wins.
  assert.equal(out.pairs[0].side, 'memos:A');
  assert.equal(out.pairs[0].other, 'memos:B');
});

test('dedupeAndCapPairs: cap truncates after dedup', () => {
  const raw = Array.from({ length: 7 }, (_, i) => ({
    side: `memos:A${i}`,
    other: `memos:B${i}`,
  }));
  const out = dedupeAndCapPairs(raw, 3);
  assert.equal(out.pairs.length, 3);
  assert.equal(out.pairs_precap, 7);
});

test('dedupeAndCapPairs: cap larger than deduped count -> no truncation', () => {
  const raw = [
    { side: 'memos:A', other: 'memos:B' },
    { side: 'memos:C', other: 'memos:D' },
  ];
  const out = dedupeAndCapPairs(raw, 24);
  assert.equal(out.pairs.length, 2);
  assert.equal(out.pairs_precap, 2);
});

test('dedupeAndCapPairs: empty input', () => {
  const out = dedupeAndCapPairs([], 24);
  assert.equal(out.pairs.length, 0);
  assert.equal(out.pairs_precap, 0);
});

// ---------------------------------------------------------------------------
// buildConflictBlock (Tasks 1.5 + 1.6)
// ---------------------------------------------------------------------------

const now = new Date('2026-05-11T12:00:00Z');
const cfgBlock = {
  conflict_min_confidence: 0.4,
  conflict_max_age_days: 30,
  conflict_max_pairs_surfaced: 3,
  conflict_block_token_budget: 300,
};

function memo({ id, content, conf = 0.7, ts = '2026-05-09T00:00:00Z', scope = 'global' }) {
  return { id, content, confidence: conf, ts, freshness: 0.5, scope };
}

test('buildConflictBlock: empty pairs -> empty string (no markers)', () => {
  const out = buildConflictBlock([], new Set(), now, cfgBlock);
  assert.equal(out.block, '');
  assert.equal(out.surfaced, 0);
  assert.equal(out.suppressed_by_rule.capped, 0);
  assert.equal(out.tokens, 0);
});

test('buildConflictBlock: single pair -> matches §2.1 line shape exactly', () => {
  const hit = memo({
    id: 'memos:m1',
    content: 'Primary bank is Chase as of 2026-05-02',
    conf: 0.75,
    ts: '2026-05-02T00:00:00Z',
  });
  const other = memo({
    id: 'memos:m2',
    content: 'Switched primary bank to Mercury 2026-04-12',
    conf: 0.85,
    ts: '2026-04-12T00:00:00Z',
  });
  const out = buildConflictBlock(
    [{ hitSide: hit, otherSide: other }],
    new Set(['memos:m1']),
    now,
    cfgBlock,
  );
  assert.ok(out.block.startsWith('<!-- conflicts -->\n'));
  assert.ok(out.block.endsWith('\n<!-- /conflicts -->'));
  assert.ok(
    out.block.includes(
      '[memo 2026-05-02] Primary bank is Chase as of 2026-05-02 <-> [memo 2026-04-12] Switched primary bank to Mercury 2026-04-12 (conf 0.75 <-> 0.85)',
    ),
  );
  assert.equal(out.surfaced, 1);
});

test('buildConflictBlock: ordering — higher max-confidence first, then newer ts, then canonical id', () => {
  const pairs = [
    // pair-1: max-conf 0.6
    {
      hitSide: memo({
        id: 'memos:a1',
        content: 'aaa',
        conf: 0.6,
        ts: '2026-05-10T00:00:00Z',
      }),
      otherSide: memo({ id: 'memos:a2', content: 'aaa-c', conf: 0.5 }),
    },
    // pair-2: max-conf 0.9 -> should come first
    {
      hitSide: memo({
        id: 'memos:b1',
        content: 'bbb',
        conf: 0.9,
        ts: '2026-05-09T00:00:00Z',
      }),
      otherSide: memo({ id: 'memos:b2', content: 'bbb-c', conf: 0.5 }),
    },
    // pair-3: max-conf 0.7
    {
      hitSide: memo({
        id: 'memos:c1',
        content: 'ccc',
        conf: 0.7,
        ts: '2026-05-08T00:00:00Z',
      }),
      otherSide: memo({ id: 'memos:c2', content: 'ccc-c', conf: 0.5 }),
    },
  ];
  const visible = new Set(['memos:a1', 'memos:b1', 'memos:c1']);
  const out = buildConflictBlock(pairs, visible, now, cfgBlock);
  // Three pairs, ordering by descending max-confidence: b (0.9), c (0.7), a (0.6).
  const idxB = out.block.indexOf('bbb');
  const idxC = out.block.indexOf('ccc');
  const idxA = out.block.indexOf('aaa');
  assert.ok(idxB < idxC && idxC < idxA, `expected b<c<a, got b=${idxB}, c=${idxC}, a=${idxA}`);
});

test('buildConflictBlock: hit-side filter — pair dropped when hitSide.id not in visibleHitIdSet', () => {
  const hit = memo({ id: 'memos:notvisible', content: 'aaa' });
  const other = memo({ id: 'memos:elsewhere', content: 'bbb' });
  const out = buildConflictBlock(
    [{ hitSide: hit, otherSide: other }],
    new Set(['memos:something-else']),
    now,
    cfgBlock,
  );
  assert.equal(out.block, '');
  assert.equal(out.surfaced, 0);
});

test('buildConflictBlock: rule 5 cap -> 5 pairs in, 3 surfaced, capped=2', () => {
  const pairs = [];
  const visible = new Set();
  for (let i = 0; i < 5; i++) {
    const hitId = `memos:hit${i}`;
    pairs.push({
      hitSide: memo({ id: hitId, content: `hit-${i}`, conf: 0.9 - i * 0.05 }),
      otherSide: memo({ id: `memos:other${i}`, content: `other-${i}`, conf: 0.5 }),
    });
    visible.add(hitId);
  }
  const out = buildConflictBlock(pairs, visible, now, {
    ...cfgBlock,
    conflict_max_pairs_surfaced: 3,
  });
  assert.equal(out.surfaced, 3);
  assert.equal(out.suppressed_by_rule.capped, 2);
});

test('buildConflictBlock: redaction one side — private content replaced, date + conf preserved', () => {
  const hit = memo({
    id: 'memos:hit',
    content: 'public side claim',
    conf: 0.7,
    ts: '2026-05-02T00:00:00Z',
  });
  const other = memo({
    id: 'memos:other',
    content: 'should not appear',
    conf: 0.4,
    scope: 'private',
  });
  const out = buildConflictBlock(
    [{ hitSide: hit, otherSide: other }],
    new Set(['memos:hit']),
    now,
    cfgBlock,
  );
  assert.ok(out.block.includes('public side claim'));
  assert.ok(!out.block.includes('should not appear'));
  assert.ok(out.block.includes('<private memo redacted>'));
  // Confidences still rendered.
  assert.ok(out.block.includes('0.70'));
  assert.ok(out.block.includes('0.40'));
  assert.equal(out.redacted_one_side, 1);
});

test('buildConflictBlock: budget overflow — drops pairs beyond budget, truncated=true', () => {
  // With a tight 80-token budget the frame consumes most of the space;
  // long lines cannot all fit, forcing truncation.
  const lineCharsForTest = 120;
  const pairs = [];
  const visible = new Set();
  for (let i = 0; i < 3; i++) {
    const hitId = `memos:hit${i}`;
    pairs.push({
      hitSide: memo({
        id: hitId,
        content: 'a'.repeat(lineCharsForTest),
        conf: 0.9 - i * 0.01,
      }),
      otherSide: memo({
        id: `memos:other${i}`,
        content: 'b'.repeat(lineCharsForTest),
        conf: 0.6,
      }),
    });
    visible.add(hitId);
  }
  const out = buildConflictBlock(pairs, visible, now, {
    ...cfgBlock,
    conflict_block_token_budget: 80,
  });
  assert.equal(out.truncated, true);
  assert.ok(out.surfaced < pairs.length);
});

test('buildConflictBlock: self-pair hit-side picked by higher confidence', () => {
  // Both endpoints in visibleHitIdSet — the §2.4 self-pair branch reads:
  // "pick the side with higher confidence as hit-side; ties broken by newer ts".
  const a = memo({
    id: 'memos:a',
    content: 'aaa-content',
    conf: 0.9,
    ts: '2026-05-05T00:00:00Z',
  });
  const b = memo({
    id: 'memos:b',
    content: 'bbb-content',
    conf: 0.6,
    ts: '2026-05-08T00:00:00Z',
  });
  // Caller passes {hitSide:a, otherSide:b} but both are in the visible set.
  // buildConflictBlock re-picks hit-side by §2.4 when both are visible.
  const out = buildConflictBlock(
    [{ hitSide: a, otherSide: b }],
    new Set(['memos:a', 'memos:b']),
    now,
    cfgBlock,
  );
  // higher-conf 'aaa-content' (0.9) leads, before the <-> separator.
  const sepIdx = out.block.indexOf(' <-> ');
  assert.ok(out.block.indexOf('aaa-content') < sepIdx);
  assert.ok(out.block.indexOf('bbb-content') > sepIdx);
});
