import assert from 'node:assert/strict';
import { test } from 'node:test';
import { attribute } from '../../cognition/intuition/attribute.js';

const baseConfig = {
  attribution_mode: 'hybrid',
  similarity_threshold: 0.35,
  jaccard_min_overlap_tokens: 2,
  citation_date_window_days: 2,
};

function makeHit({ id, kind, content, ts, meta }) {
  return { record: id, kind, content, ts, meta, rank: 0 };
}

test('attribute: explicit marker matches by record id', () => {
  const hits = [
    makeHit({
      id: 'memos:abc',
      kind: 'memo',
      content: 'sourdough hydration is 75%',
      ts: '2026-05-10T12:00:00Z',
    }),
    makeHit({
      id: 'memos:def',
      kind: 'memo',
      content: 'tomatoes planted in May',
      ts: '2026-05-09T12:00:00Z',
    }),
  ];
  const reply = 'sure. <!-- recall_used: memos:abc -->';
  const out = attribute(hits, reply, baseConfig);
  assert.equal(out[0].used, true);
  assert.equal(out[0].used_via, 'explicit');
  assert.equal(out[1].used, false);
  assert.equal(out[1].used_via, undefined);
});

test('attribute: citation pass matches event tag and date within window', () => {
  const hits = [
    makeHit({
      id: 'events:e1',
      kind: 'event',
      content: 'totally unrelated text',
      ts: '2026-05-10T08:00:00Z',
    }),
    makeHit({
      id: 'events:e2',
      kind: 'event',
      content: 'also unrelated',
      ts: '2026-05-08T08:00:00Z',
    }),
    makeHit({
      id: 'memos:m1',
      kind: 'memo',
      content: 'doesnt matter',
      ts: '2026-05-10T08:00:00Z',
      meta: { kind: 'knowledge' },
    }),
  ];
  const reply = 'I saw [event 2026-05-10] which was relevant.';
  const out = attribute(hits, reply, baseConfig);
  assert.equal(out[0].used, true);
  assert.equal(out[0].used_via, 'citation');
  // 2026-05-08 is 2 days off; window allows but the 0-day-off match
  // is picked first and consumes the citation.
  assert.equal(out[1].used, false);
  // memo hit not tagged 'episode' -> not eligible for [event ...] citation
  assert.equal(out[2].used, false);
});

test('attribute: citation date window respects zero-day setting', () => {
  const hits = [
    makeHit({ id: 'events:e1', kind: 'event', content: 'x', ts: '2026-05-10T08:00:00Z' }),
    makeHit({ id: 'events:e2', kind: 'event', content: 'y', ts: '2026-05-09T08:00:00Z' }),
  ];
  const reply = 'Per [event 2026-05-10] this happened.';
  const out = attribute(hits, reply, { ...baseConfig, citation_date_window_days: 0 });
  assert.equal(out[0].used, true);
  assert.equal(out[1].used, false);
});

test('attribute: episode tag only matches memo hits with meta.kind=episode_summary', () => {
  const hits = [
    makeHit({
      id: 'memos:m1',
      kind: 'memo',
      content: 'x',
      ts: '2026-05-10T08:00:00Z',
      meta: { kind: 'episode_summary' },
    }),
    makeHit({
      id: 'memos:m2',
      kind: 'memo',
      content: 'y',
      ts: '2026-05-10T08:00:00Z',
      meta: { kind: 'knowledge' },
    }),
  ];
  const reply = 'See [episode 2026-05-10].';
  const out = attribute(hits, reply, baseConfig);
  assert.equal(out[0].used, true);
  assert.equal(out[0].used_via, 'citation');
  assert.equal(out[1].used, false);
});

test('attribute: similarity matches asymmetric Jaccard with long reply', () => {
  const hit = makeHit({
    id: 'memos:abc',
    kind: 'memo',
    content: 'sourdough hydration ratio sixty-two percent',
    ts: '2026-05-10T08:00:00Z',
    meta: { kind: 'knowledge' },
  });
  const reply = [
    'USER: question',
    '',
    'ASSISTANT: ',
    'okay so the sourdough hydration ratio for this loaf is around sixty two percent ',
    'which works well at this altitude and given the flour we are using today.',
  ].join('\n');
  // Hit tokens >3 chars: { sourdough, hydration, ratio, sixty, percent } (5)
  // Reply contains all 5 -> 5/5 = 1.0 >= 0.35, intersection size = 5 >= 2 -> match.
  const out = attribute([hit], reply, baseConfig);
  assert.equal(out[0].used, true);
  assert.equal(out[0].used_via, 'similarity');
  assert.ok(out[0].used_score >= 0.8);
});

test('attribute: similarity rejects below threshold and below min-overlap floor', () => {
  const hit = makeHit({
    id: 'memos:abc',
    kind: 'memo',
    content: 'specific terminology window function',
    ts: '2026-05-10T08:00:00Z',
    meta: { kind: 'knowledge' },
  });
  // Reply has only "window" >3 chars in common -> intersection=1 < jaccard_min_overlap_tokens=2.
  const reply = 'USER: x\n\nASSISTANT: the window over there is fine';
  const out = attribute([hit], reply, baseConfig);
  assert.equal(out[0].used, false);
});

test('attribute: combined explicit + citation + similarity + unmatched', () => {
  const hits = [
    makeHit({
      id: 'memos:cited',
      kind: 'memo',
      content: 'aa bb cc',
      ts: '2026-05-10T08:00:00Z',
      meta: { kind: 'episode_summary' },
    }),
    makeHit({
      id: 'memos:para1',
      kind: 'memo',
      content: 'banana bread baking soda',
      ts: '2026-05-10T08:00:00Z',
      meta: { kind: 'knowledge' },
    }),
    makeHit({
      id: 'memos:para2',
      kind: 'memo',
      content: 'chicken stock simmer',
      ts: '2026-05-10T08:00:00Z',
      meta: { kind: 'knowledge' },
    }),
    makeHit({
      id: 'memos:other',
      kind: 'memo',
      content: 'unrelated unrelated foo',
      ts: '2026-05-10T08:00:00Z',
      meta: { kind: 'knowledge' },
    }),
  ];
  const reply = [
    'USER: ?',
    '',
    'ASSISTANT: per [episode 2026-05-10], that thing happened.',
    'You want banana bread baking soda? sure. And chicken stock simmer too.',
  ].join('\n');
  const out = attribute(hits, reply, baseConfig);
  assert.deepEqual(
    out.map((h) => h.used),
    [true, true, true, false],
  );
  assert.equal(out[0].used_via, 'citation');
  assert.equal(out[1].used_via, 'similarity');
  assert.equal(out[2].used_via, 'similarity');
});

test('attribute: empty reply body -> all hits used=false', () => {
  const hits = [
    makeHit({
      id: 'memos:m1',
      kind: 'memo',
      content: 'sourdough hydration ratio',
      ts: '2026-05-10T08:00:00Z',
      meta: { kind: 'knowledge' },
    }),
  ];
  const out = attribute(hits, 'USER: ping\n\nASSISTANT: ', baseConfig);
  assert.equal(out[0].used, false);
});

test('attribute: duplicate hits in ranked_hits (spec §7.10) — both scored, dedup is downstream', () => {
  // ranked_hits with the same memo twice. attribute() is pure-per-entry —
  // it does NOT dedup. Both entries match; the spec §7.10 guarantee is that
  // the downstream `memoHitCount` Map (in reinforcement.js) collapses the
  // duplicate by record id, so signal_count bumps by 1, not 2. This unit
  // test asserts the per-entry behavior; the integration test below
  // ('B1: duplicate hit dedup in memoHitCount') asserts the downstream count.
  const hits = [
    makeHit({
      id: 'memos:dup',
      kind: 'memo',
      content: 'sourdough hydration ratio sixty',
      ts: '2026-05-10T08:00:00Z',
      meta: { kind: 'knowledge' },
    }),
    makeHit({
      id: 'memos:dup',
      kind: 'memo',
      content: 'sourdough hydration ratio sixty',
      ts: '2026-05-10T08:00:00Z',
      meta: { kind: 'knowledge' },
    }),
  ];
  hits[1].rank = 1;
  const reply = 'USER: q\n\nASSISTANT: yes the sourdough hydration ratio sixty was good.';
  const out = attribute(hits, reply, baseConfig);
  assert.equal(out[0].used, true);
  assert.equal(out[1].used, true);
  assert.equal(out[0].used_via, 'similarity');
  assert.equal(out[1].used_via, 'similarity');
});

test('attribute: citation tiebreaker prefers lower rank when ts/day-delta equal', () => {
  const hits = [
    // both ts match the citation exactly; rank 0 vs rank 1.
    {
      record: 'events:e0',
      kind: 'event',
      content: 'irrelevant',
      ts: '2026-05-10T08:00:00Z',
      rank: 1,
    },
    {
      record: 'events:e1',
      kind: 'event',
      content: 'irrelevant',
      ts: '2026-05-10T12:00:00Z',
      rank: 0,
    },
  ];
  const reply = 'USER: q\n\nASSISTANT: see [event 2026-05-10] for details.';
  const out = attribute(hits, reply, baseConfig);
  // rank-0 hit consumes the citation.
  const r0 = out.find((h) => h.rank === 0);
  const r1 = out.find((h) => h.rank === 1);
  assert.equal(r0.used, true);
  assert.equal(r0.used_via, 'citation');
  assert.equal(r1.used, false);
});
