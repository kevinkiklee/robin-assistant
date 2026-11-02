import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateScript } from './generate.ts';
import { paramsWith } from './params.ts';
import { generateProbes, LATENCY_OFFSETS } from './probes.ts';
import { knowable } from './truth.ts';
import type { Disclosure, Script, Slot } from './types.ts';

const slot: Slot = {
  key: 'heron-marsh-trip',
  label: 'heron marsh trip',
  kind: 'trip',
  domain: 'travel',
  values: ['idea', 'planned', 'booked', 'dropped'],
  bait: false,
};

function mk(ds: Partial<Disclosure>[]): Script {
  return {
    seed: 0,
    horizonDays: 100,
    startDate: '2027-01-04',
    slots: [slot],
    facts: [],
    changes: [],
    assistantCalls: [],
    sessions: [],
    probes: [],
    disclosures: ds.map((d, i) => ({
      id: `d${i}`,
      slot: slot.key,
      factId: `f${i}`,
      value: 'idea',
      clarity: 'explicit',
      channel: 'session',
      kind: 'state',
      lagDays: 0,
      day: 0,
      minute: 600,
      sessionId: null,
      ...d,
    })),
  };
}

test('knowable: explicit tier is the latest explicit value', () => {
  const s = mk([
    { value: 'idea', day: 1 },
    { value: 'planned', day: 5 },
  ]);
  assert.deepEqual(knowable(s, slot.key, 0), { tier: 'none', acceptable: [], superseded: [] });
  assert.deepEqual(knowable(s, slot.key, 4), {
    tier: 'explicit',
    acceptable: ['idea'],
    superseded: [],
  });
  assert.deepEqual(knowable(s, slot.key, 5), {
    tier: 'explicit',
    acceptable: ['planned'],
    superseded: ['idea'],
  });
});

test('knowable: hedged keeps the old explicit value acceptable until a new explicit one', () => {
  const s = mk([
    { value: 'planned', day: 1 },
    { value: 'booked', day: 3, clarity: 'hedged' },
    { value: 'booked', day: 6 },
  ]);
  assert.deepEqual(knowable(s, slot.key, 3), {
    tier: 'hedged',
    acceptable: ['planned', 'booked'],
    superseded: [],
  });
  assert.deepEqual(knowable(s, slot.key, 6), {
    tier: 'explicit',
    acceptable: ['booked'],
    superseded: ['planned'],
  });
});

test('knowable: implied disclosures and never-disclosed values do not count', () => {
  const s = mk([
    { value: 'planned', day: 1 },
    { value: 'dropped', day: 2, clarity: 'implied' },
    { value: 'booked', day: null, lagDays: null },
  ]);
  assert.deepEqual(knowable(s, slot.key, 50).acceptable, ['planned']);
});

test('knowable: same-day order is by minute, then id', () => {
  const s = mk([
    { value: 'booked', day: 2, minute: 900 },
    { value: 'planned', day: 2, minute: 600 },
  ]);
  assert.deepEqual(knowable(s, slot.key, 2).acceptable, ['booked']);
});

test('probes: latency probes at fixed offsets, clipped to the horizon', () => {
  const s = mk([
    { value: 'idea', day: 1 },
    { value: 'planned', day: 80 },
  ]);
  const probes = generateProbes(s);
  for (const o of LATENCY_OFFSETS.filter((o) => 80 + o < 100)) {
    const hit = probes.find((p) => p.kind === 'current' && p.day === 80 + o);
    assert.ok(hit, `current probe on day ${80 + o}`);
    assert.deepEqual(hit.acceptable, ['planned']);
  }
  assert.ok(probes.every((p) => p.day < s.horizonDays));
  const sup = probes.filter((p) => p.kind === 'superseded');
  assert.ok(sup.every((p) => p.forbidden.includes('idea')));
});

test('probes: never-disclosed slot yields only an abstain probe', () => {
  const s = mk([{ value: 'idea', day: null, lagDays: null }]);
  const ps = generateProbes(s);
  assert.deepEqual(
    ps.map((p) => p.kind),
    ['abstain'],
  );
  assert.deepEqual(ps[0].acceptable, []);
});

test('probes: deterministic for a generated script, every acceptable list comes from knowable', () => {
  const s = generateScript(paramsWith({ horizonDays: 90 }), 11);
  const a = generateProbes(s);
  assert.equal(JSON.stringify(a), JSON.stringify(generateProbes(s)));
  for (const p of a.filter((x) => x.kind === 'current' || x.kind === 'corrected')) {
    assert.deepEqual(p.acceptable, knowable(s, p.slot, p.day).acceptable);
  }
  assert.ok(new Set(a.map((p) => p.kind)).size >= 4);
});

test('knowable: with a minute, only disclosures at or before it count that day', () => {
  const s = mk([
    { value: 'idea', day: 1, minute: 300 },
    { value: 'planned', day: 2, minute: 600 },
  ]);
  assert.deepEqual(knowable(s, slot.key, 2, 599).acceptable, ['idea']);
  assert.deepEqual(knowable(s, slot.key, 2, 600).acceptable, ['planned']);
  assert.deepEqual(knowable(s, slot.key, 2).acceptable, ['planned']);
});

test('knowable: same-minute ties break by code point, not locale', () => {
  const s = mk([
    { id: 'd9', value: 'planned', day: 2, sessionId: 'sx' },
    { id: 'd10', value: 'booked', day: 2, sessionId: 'sx' },
  ] as Partial<Disclosure>[]);
  // 'd10' < 'd9' in code points, so d9 is the later statement.
  assert.deepEqual(knowable(s, slot.key, 2).acceptable, ['planned']);
});

test('probes: one probe per (slot, day, kind) across seeds', () => {
  for (const seed of [1, 2, 3, 4]) {
    const s = generateScript(paramsWith({ horizonDays: 365 }), seed);
    const ps = generateProbes(s);
    const keys = ps.map((p) => `${p.slot}|${p.day}|${p.kind}`);
    assert.equal(new Set(keys).size, keys.length, `seed ${seed}`);
    for (let i = 1; i < ps.length; i++) assert.ok(ps[i - 1].day <= ps[i].day);
  }
});

test('probes: the monthly current sample is seeded, not alphabetical', () => {
  const s = generateScript(paramsWith({ horizonDays: 365 }), 13);
  const monthly = (sc: Script, day: number) =>
    generateProbes(sc)
      .filter((p) => p.kind === 'current' && p.day === day)
      .map((p) => p.slot);
  const ready = s.slots
    .map((x) => x.key)
    .sort()
    .filter((k) => knowable(s, k, 89).tier === 'explicit');
  assert.ok(ready.length > 5);
  const got = monthly(s, 89);
  assert.equal(JSON.stringify(got), JSON.stringify(monthly(s, 89)));
  const firstFive = ready.slice(0, 5);
  assert.ok(
    firstFive.some((k) => !got.includes(k)),
    'sample is not just the first five keys',
  );
});
