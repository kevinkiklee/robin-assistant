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
