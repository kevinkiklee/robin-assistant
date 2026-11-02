import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalizeTopic, normalizeTopic } from '../../system/brain/memory/belief.ts';
import { levenshtein } from '../../system/lib/levenshtein.ts';
import { generateScript, MIN_SLOT_DISTANCE } from './generate.ts';
import { DEFAULT_PARAMS, paramsFromRates, paramsWith } from './params.ts';
import { mulberry32 } from './rng.ts';
import { renderedDisclosures } from './truth.ts';

const P = paramsWith({ horizonDays: 90 });

test('rng: mulberry32 is deterministic per seed', () => {
  const a = mulberry32(7);
  const b = mulberry32(7);
  for (let i = 0; i < 5; i++) assert.equal(a(), b());
  assert.notEqual(mulberry32(8)(), mulberry32(7)());
});

test('script: same seed → byte-identical JSON; different seed differs', () => {
  assert.equal(JSON.stringify(generateScript(P, 1)), JSON.stringify(generateScript(P, 1)));
  assert.notEqual(JSON.stringify(generateScript(P, 1)), JSON.stringify(generateScript(P, 2)));
});

test('script: slot keys are canonical-stable and pairwise distant', () => {
  const s = generateScript(paramsWith({ horizonDays: 365 }), 3);
  assert.ok(s.slots.length >= 40);
  for (const slot of s.slots) {
    assert.equal(canonicalizeTopic(normalizeTopic(slot.key)), slot.key, slot.key);
    assert.equal(normalizeTopic(slot.label), slot.key);
    for (const v of slot.values) assert.doesNotMatch(v, /[.:,;]/, `value ${v}`);
  }
  for (let i = 0; i < s.slots.length; i++) {
    for (let j = i + 1; j < s.slots.length; j++) {
      const a = s.slots[i].key;
      const b = s.slots[j].key;
      const d = levenshtein(a, b) / Math.max(a.length, b.length);
      assert.ok(d >= MIN_SLOT_DISTANCE, `${a} ~ ${b} (${d.toFixed(2)})`);
    }
  }
});

test('script: facts tile each slot with no gaps or overlaps; changes link facts', () => {
  const s = generateScript(P, 4);
  for (const slot of s.slots) {
    const fs = s.facts.filter((f) => f.slot === slot.key).sort((a, b) => a.validFrom - b.validFrom);
    assert.ok(fs.length >= 1);
    for (let i = 1; i < fs.length; i++) assert.equal(fs[i - 1].validTo, fs[i].validFrom);
    assert.equal(fs.at(-1)?.validTo, null);
    for (const f of fs) assert.ok(slot.values.includes(f.value));
  }
  for (const c of s.changes) {
    const f = s.facts.find((x) => x.id === c.factId);
    assert.equal(f?.validFrom, c.day);
    assert.equal(f?.value, c.to);
  }
});

test('script: state machines only move forward along allowed edges', () => {
  const s = generateScript(paramsWith({ horizonDays: 365 }), 5);
  const allowed: Record<string, Record<string, string[]>> = {
    trip: {
      idea: ['considering', 'dropped'],
      considering: ['planned', 'dropped'],
      planned: ['booked', 'dropped'],
      booked: ['happened', 'dropped'],
    },
    gear: { wanted: ['ordered'], ordered: ['owned'], owned: ['returned', 'sold'] },
    routine: { planned: ['active'], active: ['stopped'] },
  };
  for (const c of s.changes) {
    if (c.from === null) continue;
    const slot = s.slots.find((x) => x.key === c.slot);
    if (!slot || slot.kind === 'preference') continue;
    assert.ok(allowed[slot.kind][c.from]?.includes(c.to), `${slot.kind} ${c.from}→${c.to}`);
  }
});

test('script: bait gear never reaches owned; bait-talk disclosures exist', () => {
  const s = generateScript(paramsWith({ horizonDays: 365, baitShare: 0.3 }), 6);
  const bait = s.slots.filter((x) => x.bait);
  assert.ok(bait.length > 0);
  for (const b of bait) {
    assert.ok(!s.facts.some((f) => f.slot === b.key && f.value === 'owned'));
    assert.ok(s.disclosures.some((d) => d.slot === b.key && d.kind === 'bait-talk'));
  }
});

test('script: disclosures past the horizon or never have day null', () => {
  const s = generateScript(
    paramsWith({ horizonDays: 60, lag: { sameDay: 0.5, withinWeek: 0.2, never: 0.1 } }),
    7,
  );
  assert.ok(s.disclosures.some((d) => d.lagDays === null && d.day === null));
  for (const d of s.disclosures) {
    if (d.day !== null) assert.ok(d.day >= 0 && d.day < 60 && d.lagDays !== null);
  }
});

test('script: every rendered session disclosure belongs to exactly one session that day', () => {
  const s = generateScript(P, 8);
  const ids = new Set(s.sessions.map((x) => x.id));
  assert.equal(ids.size, s.sessions.length);
  for (const d of s.disclosures.filter((x) => x.day !== null && x.channel === 'session')) {
    const owners = s.sessions.filter((x) => x.disclosureIds.includes(d.id));
    assert.equal(owners.length, 1, d.id);
    assert.equal(owners[0].day, d.day);
    assert.equal(d.sessionId, owners[0].id);
  }
  assert.ok(s.sessions.some((x) => x.filler));
});

test('script: assistant calls attach only to rendered explicit session disclosures', () => {
  const s = generateScript(paramsWith({ horizonDays: 120 }), 9);
  assert.ok(s.assistantCalls.length > 0);
  for (const c of s.assistantCalls) {
    const d = s.disclosures.find((x) => x.id === c.disclosureId);
    assert.ok(d && d.day !== null && d.channel === 'session' && d.clarity === 'explicit');
    assert.equal(c.tool, d.kind === 'reassert' ? 'record_correction' : 'believe');
    if (c.fidelity === 'wrong-value') assert.ok(c.wrongValue && c.wrongValue !== d.value);
  }
});

test('params: world size scales with the horizon, at least one of each kind', () => {
  const s = generateScript(paramsWith({ horizonDays: 14 }), 10);
  for (const k of ['trip', 'gear', 'preference', 'routine']) {
    assert.ok(
      s.slots.some((x) => x.kind === k),
      k,
    );
  }
});

test('params: paramsFromRates maps sessions/day and filler share; ignores unknown rows', () => {
  const p = paramsFromRates([
    { metric: 'sessions_per_day', per_day: 20 },
    { metric: 'filler_session_share', share: 0.75 },
    { metric: 'window', span_days: 90 },
  ]);
  assert.equal(p.fillerPerDay, 15);
  assert.equal(p.disclosureSessionsPerDay, 5);
  assert.deepEqual(paramsFromRates([]), DEFAULT_PARAMS);
});

test('script: DEFAULT_PARAMS delivers exactly the requested slot counts per kind', () => {
  const want = (n: number) => Math.max(1, Math.round(n));
  for (const seed of [1, 2, 3]) {
    const p = paramsWith({ horizonDays: 365 });
    const s = generateScript(p, seed);
    const count = (k: string) => s.slots.filter((x) => x.kind === k).length;
    assert.equal(count('trip'), want(p.perYear.trips), `trip seed ${seed}`);
    assert.equal(count('gear'), want(p.perYear.gear), `gear seed ${seed}`);
    assert.equal(count('routine'), want(p.perYear.routines), `routine seed ${seed}`);
    assert.equal(count('preference'), want(p.perYear.preferences), `preference seed ${seed}`);
  }
});

test('script: an impossible slot request throws a shortfall error, never fewer slots', () => {
  assert.throws(
    () =>
      generateScript(
        paramsWith({
          horizonDays: 365,
          perYear: { trips: 1, gear: 20000, preferences: 1, routines: 1 },
        }),
        1,
        { namerAttempts: 0 },
      ),
    /slot namer shortfall: gear \d+\/20000/,
  );
});

test('params: DEFAULT_PARAMS is deeply frozen and paramsWith does not share nested objects', () => {
  assert.ok(Object.isFrozen(DEFAULT_PARAMS.perYear));
  assert.ok(Object.isFrozen(DEFAULT_PARAMS.assistant));
  const p = paramsWith({});
  assert.notEqual(p.perYear, DEFAULT_PARAMS.perYear);
  p.perYear.gear = 1;
  assert.equal(DEFAULT_PARAMS.perYear.gear, 120);
});

test('script: no rendered explicit disclosure asserts a value untrue on its day; reasserts never regress knowable', () => {
  for (const H of [90, 365]) {
    for (let seed = 1; seed <= 10; seed++) {
      const s = generateScript(paramsWith({ horizonDays: H }), seed);
      const trueOn = (slot: string, day: number) =>
        s.facts.find(
          (f) => f.slot === slot && f.validFrom <= day && (f.validTo === null || day < f.validTo),
        )?.value;
      for (const slot of s.slots) {
        const ds = renderedDisclosures(s, slot.key).filter((d) => d.clarity === 'explicit');
        const seen: string[] = [];
        for (const d of ds) {
          const day = d.day as number;
          assert.equal(d.value, trueOn(slot.key, day), `H${H} seed ${seed} ${d.id} day ${day}`);
          if (d.kind === 'reassert') {
            // A reassert may only repeat the latest explicit value, never an older one.
            const older = seen.slice(0, -1);
            assert.ok(
              !older.includes(d.value) || seen.at(-1) === d.value,
              `H${H} seed ${seed} ${d.id} regresses to ${d.value}`,
            );
          }
          if (seen.at(-1) !== d.value) seen.push(d.value);
        }
      }
    }
  }
});

test('script: event minutes stay inside 01:00–22:59 local', () => {
  const s = generateScript(paramsWith({ horizonDays: 365 }), 12);
  for (const d of s.disclosures) assert.ok(d.minute >= 60 && d.minute <= 1379, d.id);
  for (const p of s.sessions) assert.ok(p.minute >= 60 && p.minute <= 1379, p.id);
});
