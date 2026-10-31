import assert from 'node:assert';
import { test } from 'node:test';
import {
  formatLastCallOverflow,
  lastCallOverflowCount,
  type OpenLoopItem,
  rankOpenLoops,
  scoreOpenLoop,
} from './rank.ts';

const DAY = 86_400_000;
const NOW = Date.parse('2026-08-10T12:00:00Z');

function item(over: Partial<OpenLoopItem>): OpenLoopItem {
  return {
    id: 1,
    subject: 'Generic Thing Two',
    claim: 'do it',
    verdict: 'try',
    domain: 'creative',
    confidence: 0.5,
    createdAtMs: NOW - 10 * DAY,
    expiresAtMs: NOW + 30 * DAY,
    ...over,
  };
}

test('closer expiry scores higher', () => {
  const ctx = { nowMs: NOW, contextTexts: [] };
  const soon = scoreOpenLoop(item({ expiresAtMs: NOW + 3 * DAY }), ctx);
  const far = scoreOpenLoop(item({ expiresAtMs: NOW + 60 * DAY }), ctx);
  assert.ok(soon > far);
});

test('context match boosts score', () => {
  const base = item({ subject: 'Coast Trip' });
  const plain = scoreOpenLoop(base, { nowMs: NOW, contextTexts: [] });
  const boosted = scoreOpenLoop(base, {
    nowMs: NOW,
    contextTexts: ['Coast trip prep window'],
  });
  assert.ok(boosted > plain + 0.5);
});

test('domain rotation caps ranked slots per domain at maxPerDomain', () => {
  const items = [
    item({ id: 1, domain: 'creative', confidence: 0.9 }),
    item({ id: 2, domain: 'creative', confidence: 0.8 }),
    item({ id: 3, domain: 'creative', confidence: 0.7 }),
    item({ id: 4, domain: 'creative', confidence: 0.6 }),
    item({ id: 5, domain: 'finance', confidence: 0.1 }),
  ];
  const { ranked } = rankOpenLoops(items, { nowMs: NOW, contextTexts: [] });
  assert.equal(ranked.filter((i) => i.domain === 'creative').length, 3);
  assert.ok(ranked.some((i) => i.domain === 'finance'));
});

test('last-call: soonest-lapsing fill the slots; overflow counted; no double-listing', () => {
  const items = [
    item({ id: 1, expiresAtMs: NOW + 1 * DAY }),
    item({ id: 2, expiresAtMs: NOW + 2 * DAY }),
    item({ id: 3, expiresAtMs: NOW + 3 * DAY }),
    item({ id: 4, expiresAtMs: NOW + 40 * DAY }),
  ];
  const r = rankOpenLoops(items, { nowMs: NOW, contextTexts: [] });
  assert.deepEqual(
    r.lastCall.map((i) => i.id),
    [1, 2],
  );
  assert.equal(r.lastCallOverflow, 1); // id 3 was eligible, no slot
  assert.ok(!r.ranked.some((i) => i.id === 1 || i.id === 2)); // not listed twice
});

test('null expiry ranks as low urgency but is still eligible', () => {
  const r = rankOpenLoops([item({ id: 9, expiresAtMs: null })], {
    nowMs: NOW,
    contextTexts: [],
  });
  assert.deepEqual(
    r.ranked.map((i) => i.id),
    [9],
  );
});

test('skip/avoid/wait items never take last-call slots (their lapse resolves held)', () => {
  const items = [
    item({ id: 1, verdict: 'skip', expiresAtMs: NOW + 1 * DAY }),
    item({ id: 2, verdict: 'buy', expiresAtMs: NOW + 2 * DAY }),
    item({ id: 3, verdict: 'wait', expiresAtMs: NOW + 3 * DAY }),
  ];
  const r = rankOpenLoops(items, { nowMs: NOW, contextTexts: [] }, { lastCallSlots: 2 });
  assert.deepEqual(
    r.lastCall.map((i) => i.id),
    [2],
  );
  assert.equal(r.lastCallOverflow, 0);
});

test('lastCallOverflowCount matches rankOpenLoops; formatLastCallOverflow renders the line', () => {
  const items = Array.from({ length: 6 }, (_, n) =>
    item({ id: n + 1, verdict: 'try', expiresAtMs: NOW + (n + 1) * DAY }),
  );
  const r = rankOpenLoops(items, { nowMs: NOW, contextTexts: [] });
  assert.equal(lastCallOverflowCount(items, NOW), r.lastCallOverflow);
  assert.equal(lastCallOverflowCount(items, NOW), 4);
  assert.match(formatLastCallOverflow(4), /^\+4 more lapsing in the next 7 days/);
  assert.equal(formatLastCallOverflow(0), '');
});
