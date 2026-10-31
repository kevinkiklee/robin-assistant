import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type ConfidenceInput, computeConfidence } from './confidence.ts';

const NOW = new Date('2026-06-17T12:00:00Z');

function daysAgo(n: number): Date {
  return new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);
}

function base(overrides: Partial<ConfidenceInput> = {}): ConfidenceInput {
  return {
    supportCount: 4,
    supportStreams: 2,
    lastReinforcedAt: daysAgo(1),
    contradictionCount: 0,
    now: NOW,
    ...overrides,
  };
}

test('output is always within [0, 1]', () => {
  const inputs: ConfidenceInput[] = [
    base(),
    base({ supportCount: 0, supportStreams: 0 }),
    base({ supportCount: 1000, supportStreams: 50 }),
    base({ contradictionCount: 100 }),
    base({ lastReinforcedAt: daysAgo(5000) }),
    base({ supportCount: -5, supportStreams: -3, contradictionCount: -2 }),
    base({ lastReinforcedAt: new Date(NOW.getTime() + 10_000) }), // future → ageDays clamps to 0
  ];
  for (const input of inputs) {
    const c = computeConfidence(input);
    assert.ok(c >= 0 && c <= 1, `expected 0..1, got ${c}`);
  }
});

test('more support → higher (monotone non-decreasing in support_count)', () => {
  let prev = -1;
  for (const supportCount of [0, 1, 2, 3, 4, 8, 16]) {
    const c = computeConfidence(base({ supportCount }));
    assert.ok(c >= prev, `support ${supportCount}: ${c} < ${prev}`);
    prev = c;
  }
  // Strictly higher across a meaningful jump.
  assert.ok(
    computeConfidence(base({ supportCount: 8 })) > computeConfidence(base({ supportCount: 2 })),
  );
});

test('more streams → higher (single-stream patterns stay weaker)', () => {
  const oneStream = computeConfidence(base({ supportStreams: 1 }));
  const twoStreams = computeConfidence(base({ supportStreams: 2 }));
  const threeStreams = computeConfidence(base({ supportStreams: 3 }));
  assert.ok(twoStreams > oneStream, 'two streams should beat one');
  assert.ok(threeStreams >= twoStreams, 'three streams ≥ two (capped multiplier)');
});

test('older last_reinforced → lower (recency decay)', () => {
  const fresh = computeConfidence(base({ lastReinforcedAt: daysAgo(1) }));
  const mid = computeConfidence(base({ lastReinforcedAt: daysAgo(45) }));
  const old = computeConfidence(base({ lastReinforcedAt: daysAgo(180) }));
  assert.ok(fresh > mid, `fresh ${fresh} should beat 45d ${mid}`);
  assert.ok(mid > old, `45d ${mid} should beat 180d ${old}`);
  // Half-life ≈ 45 days: confidence at 45d should be ~half of the no-decay value.
  const noDecay = computeConfidence(base({ lastReinforcedAt: NOW }));
  assert.ok(
    Math.abs(mid - noDecay * 0.5) < 0.05,
    `45d should be ~half: ${mid} vs ${noDecay * 0.5}`,
  );
});

test('more contradictions → lower (penalty)', () => {
  let prev = Infinity;
  for (const contradictionCount of [0, 1, 2, 4]) {
    const c = computeConfidence(base({ contradictionCount }));
    assert.ok(c <= prev, `contradictions ${contradictionCount}: ${c} > ${prev}`);
    prev = c;
  }
  assert.ok(
    computeConfidence(base({ contradictionCount: 0 })) >
      computeConfidence(base({ contradictionCount: 3 })),
  );
});

test('deterministic — same input yields same output', () => {
  const input = base();
  const a = computeConfidence(input);
  const b = computeConfidence({ ...input });
  assert.equal(a, b);
});

test('accepts a SQLite-utc string timestamp for last_reinforced', () => {
  const asString = computeConfidence(base({ lastReinforcedAt: '2026-06-16 12:00:00' }));
  const asDate = computeConfidence(base({ lastReinforcedAt: daysAgo(1) }));
  assert.ok(Math.abs(asString - asDate) < 1e-9, `${asString} vs ${asDate}`);
});

test('zero support → zero confidence', () => {
  assert.equal(computeConfidence(base({ supportCount: 0, supportStreams: 0 })), 0);
});
