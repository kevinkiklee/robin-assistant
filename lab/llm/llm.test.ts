import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { getPrompt, resetPrompts, setPrompts } from '../../system/brain/cognition/prompts.ts';
import { simPrompts } from '../privacy/sim-prompts.ts';
import { claimSentence, reassertSentence, stateSentence } from '../render/grammar.ts';
import { LabIsolationError } from '../sandbox/errors.ts';
import { buildLabDispatcher } from './lab-dispatcher.ts';
import { EMBED_DIM, LabUnhandledPromptError } from './template-provider.ts';

afterEach(() => resetPrompts());

test('template: claims prompt → one claim per grammar statement, domain-tagged', async () => {
  setPrompts(simPrompts());
  const { llm } = buildLabDispatcher({ mode: 'template' });
  const text = `[USER] ${stateSentence('heron marsh trip', 'booked', 'explicit')}\n[USER] ${stateSentence('headlamp gear', 'wanted', 'hedged')}`;
  const res = await llm.invoke('reasoning', {
    systemPrompt: getPrompt('biographer.claims'),
    messages: [{ role: 'user', content: text }],
  });
  assert.deepEqual(JSON.parse(res.text), {
    claims: [
      {
        topic: 'heron-marsh-trip',
        claim: claimSentence('heron marsh trip', 'booked'),
        confidence: 0.95,
        domain: 'travel',
      },
      {
        topic: 'headlamp-gear',
        claim: claimSentence('headlamp gear', 'wanted'),
        confidence: 0.6,
        domain: 'creative',
      },
    ],
  });
  assert.equal(res.costUsd, 0);
});

test('template: a doc body yields only its last statement per label', async () => {
  setPrompts(simPrompts());
  const { llm } = buildLabDispatcher({ mode: 'template' });
  const doc = [
    '# heron marsh trip',
    '',
    stateSentence('heron marsh trip', 'idea', 'explicit'),
    stateSentence('headlamp gear', 'wanted', 'explicit'),
    stateSentence('heron marsh trip', 'planned', 'explicit'),
    stateSentence('heron marsh trip', 'booked', 'hedged'),
  ].join('\n');
  const res = await llm.invoke('reasoning', {
    systemPrompt: getPrompt('biographer.claims'),
    messages: [{ role: 'user', content: doc }],
  });
  const got = (JSON.parse(res.text) as { claims: { claim: string }[] }).claims.map((c) => c.claim);
  assert.deepEqual(got, [
    claimSentence('headlamp gear', 'wanted'),
    claimSentence('heron marsh trip', 'booked'),
  ]);
});

test('template: reconcile judge labels same / refines / unrelated', async () => {
  setPrompts(simPrompts());
  const { llm } = buildLabDispatcher({ mode: 'template' });
  const item = (n: number, cur: string, nw: string) =>
    `ITEM ${n} (topic 't')\n  current (2027-01-05): ${cur}\n  new: ${nw}`;
  const body = [
    item(0, claimSentence('a b trip', 'idea'), claimSentence('a b trip', 'idea')),
    item(1, claimSentence('a b trip', 'idea'), claimSentence('a b trip', 'planned')),
    item(2, claimSentence('a b trip', 'idea'), 'Something else.'),
  ].join('\n');
  const res = await llm.invoke('classify', {
    systemPrompt: getPrompt('reconcile.judge'),
    messages: [{ role: 'user', content: body }],
  });
  const expected = {
    verdicts: [
      { item: 0, verdict: 'same' },
      { item: 1, verdict: 'refines' },
      { item: 2, verdict: 'unrelated' },
    ],
  };
  assert.deepEqual(res.structured, expected);
  assert.deepEqual(JSON.parse(res.text), expected);
});

test('template: an unknown prompt throws and is recorded', async () => {
  const { llm, template } = buildLabDispatcher({ mode: 'template' });
  await assert.rejects(
    llm.invoke('reasoning', {
      systemPrompt: 'Totally new prompt',
      messages: [{ role: 'user', content: 'x' }],
    }),
    LabUnhandledPromptError,
  );
  assert.deepEqual(template?.stats.unhandled, ['Totally new prompt']);
});

test('template: embeddings are deterministic, normalized, and similarity-ordered', async () => {
  const { llm } = buildLabDispatcher({ mode: 'template' });
  const [a, b, c] = await llm.embed('embed', [
    reassertSentence('heron marsh trip', 'booked'),
    stateSentence('heron marsh trip', 'booked', 'explicit'),
    'Refactor pass: renamed the parser helper.',
  ]);
  assert.equal(a.length, EMBED_DIM);
  const dot = (x: number[], y: number[]) => x.reduce((s, v, i) => s + v * y[i], 0);
  assert.ok(Math.abs(dot(a, a) - 1) < 1e-9);
  assert.ok(dot(a, b) > dot(a, c));
  assert.deepEqual(
    (await llm.embed('embed', reassertSentence('heron marsh trip', 'booked')))[0],
    a,
  );
});

test('lab dispatcher: config mode refuses claude-agent before building anything', () => {
  const models = { roles: { reasoning: { provider: 'claude-agent', model: 'x' } } } as never;
  assert.throws(() => buildLabDispatcher({ mode: 'config', models }), LabIsolationError);
  const fb = {
    roles: {
      reasoning: {
        provider: 'anthropic',
        model: 'x',
        fallback: { provider: 'claude-agent', model: 'y' },
      },
    },
  } as never;
  assert.throws(() => buildLabDispatcher({ mode: 'config', models: fb }), LabIsolationError);
});
