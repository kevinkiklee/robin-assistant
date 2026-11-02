import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { canonicalizeTopic, normalizeTopic } from '../../system/brain/memory/belief.ts';
import { levenshtein } from '../../system/lib/levenshtein.ts';
import { generateScript } from '../script/generate.ts';
import { paramsWith } from '../script/params.ts';
import { knowable } from '../script/truth.ts';
import type { Disclosure } from '../script/types.ts';
import { buildFixture, itemsForDay, readFixture } from './fixture.ts';
import {
  claimSentence,
  domainForLabel,
  parseClaim,
  parseStatements,
  reassertSentence,
  stateSentence,
} from './grammar.ts';
import { MIN_SESSION_CHARS, renderTemplate, sloppyTopic } from './template.ts';

test('grammar: every sentence form round-trips', () => {
  assert.deepEqual(parseStatements(stateSentence('heron marsh trip', 'booked', 'explicit')), [
    { label: 'heron marsh trip', value: 'booked', confidence: 0.95 },
  ]);
  assert.deepEqual(parseStatements(stateSentence('heron marsh trip', 'booked', 'hedged')), [
    { label: 'heron marsh trip', value: 'booked', confidence: 0.6 },
  ]);
  assert.deepEqual(parseStatements(stateSentence('heron marsh trip', 'booked', 'implied')), []);
  assert.deepEqual(parseStatements(reassertSentence('headlamp gear', 'returned')), [
    { label: 'headlamp gear', value: 'returned', confidence: 0.95 },
  ]);
  assert.deepEqual(parseClaim(claimSentence('morning drink pick', 'green tea')), {
    label: 'morning drink pick',
    value: 'green tea',
  });
  assert.equal(parseClaim('Sim User likes hiking.'), null);
  assert.equal(domainForLabel('morning stretch habit'), 'health');
  assert.equal(domainForLabel('heron marsh trip'), 'travel');
  assert.equal(domainForLabel('headlamp gear'), 'creative');
  assert.equal(domainForLabel('morning drink pick'), 'preferences');
  assert.equal(domainForLabel('something else'), null);
});

test('grammar: parseStatements finds several statements inside a transcript chunk', () => {
  const chunk = `[USER] ${stateSentence('a b trip', 'idea', 'explicit')}\n[ASSISTANT] Noted.\n[USER] ${reassertSentence('c d gear', 'owned')}`;
  assert.equal(parseStatements(chunk).length, 2);
});

test('template: sessions are unique, long enough, and carry every session disclosure', () => {
  const s = generateScript(paramsWith({ horizonDays: 45 }), 21);
  const items = renderTemplate(s);
  const sessions = items.filter((i) => i.type === 'session');
  const bodies = sessions.map((x) => x.turns.map((t) => t.content).join('\n'));
  assert.equal(new Set(bodies).size, bodies.length);
  for (const b of bodies) assert.ok(b.length >= MIN_SESSION_CHARS);
  for (const d of s.disclosures.filter(
    (x) => x.day !== null && x.channel === 'session' && x.clarity !== 'implied',
  )) {
    const sess = sessions.find((x) => x.sessionId === d.sessionId);
    assert.ok(sess, d.id);
    const found = parseStatements(sess.turns.map((t) => t.content).join('\n'));
    const label = s.slots.find((x) => x.key === d.slot)?.label;
    assert.ok(
      found.some((f) => f.label === label && f.value === d.value),
      d.id,
    );
  }
});

test('template: assistant-call topics stay canonical-stable; sloppy topics differ from the slot', () => {
  const s = generateScript(
    paramsWith({
      horizonDays: 120,
      assistant: { callRate: 1, omitted: 0, sloppyTopic: 0.5, wrongValue: 0.2 },
    }),
    22,
  );
  const calls = renderTemplate(s).filter((i) => i.type === 'assistant-call');
  assert.ok(calls.some((c) => c.fidelity === 'sloppy-topic'));
  for (const c of calls) {
    assert.equal(canonicalizeTopic(normalizeTopic(c.topic)), c.topic, c.topic);
    if (c.fidelity === 'sloppy-topic') {
      const d = levenshtein(c.topic, c.slot) / Math.max(c.topic.length, c.slot.length);
      assert.ok(d >= 0.4, `${c.topic} would merge into ${c.slot}`);
    } else assert.equal(c.topic, c.slot);
  }
});

test('fixture: build → read round-trips, never-disclosed nulls survive, itemsForDay sorts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lab-fixture-'));
  const meta = buildFixture(dir, paramsWith({ horizonDays: 30 }), 23);
  const { meta: m2, script, items } = readFixture(dir);
  assert.deepEqual(m2, meta);
  assert.equal(meta.renderer, 'template');
  assert.ok(script.probes.length > 0);
  assert.ok(script.disclosures.every((d) => d.day === null || Number.isInteger(d.day)));
  const day3 = itemsForDay(items, 3);
  for (let i = 1; i < day3.length; i++) assert.ok(day3[i - 1].minute <= day3[i].minute);
});

test('template: sloppyTopic holds for every slot across seeds', () => {
  for (let seed = 1; seed <= 12; seed++) {
    for (const slot of generateScript(paramsWith({ horizonDays: 365 }), seed).slots) {
      const t = sloppyTopic(slot.key);
      assert.equal(canonicalizeTopic(normalizeTopic(t)), t);
      assert.ok(levenshtein(t, slot.key) / Math.max(t.length, slot.key.length) >= 0.4, slot.key);
    }
  }
});

test('template: throws on a missing disclosure, a call without a plan, or wrong-value without a value', () => {
  const base = generateScript(
    paramsWith({
      horizonDays: 30,
      assistant: { callRate: 1, omitted: 0, sloppyTopic: 0, wrongValue: 0 },
    }),
    24,
  );
  const clone = () => structuredClone(base);
  const a = clone();
  a.sessions.find((x) => !x.filler)?.disclosureIds.push('d-missing');
  assert.throws(() => renderTemplate(a), /unknown disclosure d-missing/);
  const b = clone();
  const id = b.assistantCalls[0].disclosureId;
  for (const p of b.sessions) p.disclosureIds = p.disclosureIds.filter((x) => x !== id);
  assert.throws(() => renderTemplate(b), /has no session plan/);
  const c = clone();
  c.assistantCalls[0].fidelity = 'wrong-value';
  c.assistantCalls[0].wrongValue = null;
  assert.throws(() => renderTemplate(c), /has no wrongValue/);
});

test('template: same-session same-slot turns follow knowable order', () => {
  const s = generateScript(paramsWith({ horizonDays: 30 }), 25);
  const sess = s.sessions.find((x) => !x.filler) as (typeof s.sessions)[number];
  const d0 = s.disclosures.find((x) => x.id === sess.disclosureIds[0]) as Disclosure;
  // Two explicit disclosures of one slot in one session, ids out of numeric order:
  // 'd100' < 'd99' in code points, so d100 is spoken first and knowable ends on d99.
  const mk = (id: string, value: string): Disclosure => ({
    ...d0,
    id,
    value,
    clarity: 'explicit',
    kind: 'state',
    channel: 'session',
  });
  s.disclosures.push(mk('d99', 'second'), mk('d100', 'first'));
  sess.disclosureIds = ['d99', 'd100', ...sess.disclosureIds];
  const item = renderTemplate(s).find(
    (i) => i.type === 'session' && i.sessionId === sess.id,
  ) as Extract<ReturnType<typeof renderTemplate>[number], { type: 'session' }>;
  const label = s.slots.find((x) => x.key === d0.slot)?.label;
  const spoken = parseStatements(item.turns.map((t) => t.content).join('\n'))
    .filter((x) => x.label === label && (x.value === 'first' || x.value === 'second'))
    .map((x) => x.value);
  assert.deepEqual(spoken, ['first', 'second']);
  const k = knowable(s, d0.slot, sess.day);
  assert.ok(k.acceptable.includes('second') && !k.acceptable.includes('first'));
});

test('template: assistant-call minutes never pass 22:59 and sort after their session', () => {
  const s = generateScript(
    paramsWith({
      horizonDays: 60,
      assistant: { callRate: 1, omitted: 0, sloppyTopic: 0, wrongValue: 0 },
    }),
    26,
  );
  const plan = s.sessions.find(
    (x) => !x.filler && x.disclosureIds.length > 1,
  ) as (typeof s.sessions)[number];
  plan.minute = 1379;
  for (const id of plan.disclosureIds) {
    const d = s.disclosures.find((x) => x.id === id) as Disclosure;
    d.minute = 1379;
  }
  const items = renderTemplate(s);
  assert.ok(items.every((i) => i.minute <= 1379));
  const day = itemsForDay(items, plan.day);
  const at = day.findIndex((i) => i.type === 'session' && i.sessionId === plan.id);
  for (const id of plan.disclosureIds) {
    const call = day.findIndex((i) => i.id === `call:${id}`);
    if (call >= 0) assert.ok(call > at, `call ${id} sorts after its session`);
  }
});
