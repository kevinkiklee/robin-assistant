import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { setOperatorProfileForTests } from '../../lib/operator-profile.ts';
import {
  getDefaultPrompt,
  getPrompt,
  PROMPT_KEYS,
  promptRegistryVersion,
  resetPrompts,
  setPrompts,
} from './prompts.ts';

// A fixed profile: the suite must not read the real operator.yaml.
const PROFILE = {
  name: 'Quinn',
  context: 'Context: The user is Quinn, a potter in Leeds.',
  aliases: [],
  privateTerms: [],
  home: null,
};
beforeEach(() => setOperatorProfileForTests(PROFILE));
afterEach(() => {
  resetPrompts();
  setOperatorProfileForTests(null);
});

test('prompts: the operator profile fills {{USER_NAME}} and the user context', () => {
  assert.equal(getPrompt('biographer.userContext'), PROFILE.context);
  assert.ok(getPrompt('biographer.claims').includes('DURABLE PERSONAL FACTS about Quinn'));
  assert.ok(getPrompt('biographer.entities').includes(PROFILE.context));
  for (const k of PROMPT_KEYS) assert.ok(!getPrompt(k).includes('{{USER_NAME}}'), k);
});

test('prompts: no profile → generic "the user" and an empty context', () => {
  setOperatorProfileForTests({
    name: null,
    context: null,
    aliases: [],
    privateTerms: [],
    home: null,
  });
  assert.equal(getPrompt('biographer.userContext'), '');
  assert.ok(getPrompt('biographer.claims').includes('DURABLE PERSONAL FACTS about the user'));
});

test('prompts: any override (a lab run) never applies the real profile', () => {
  setPrompts({ 'biographer.userContext': 'Context: The user is Sim User.' });
  for (const k of PROMPT_KEYS) assert.ok(!getPrompt(k).includes('Quinn'), k);
  assert.ok(getPrompt('reconcile.judge').includes('memory store about the user.'));
});

test('prompts: entities prompt embeds the current user context', () => {
  assert.ok(getPrompt('biographer.entities').includes(getPrompt('biographer.userContext')));
  assert.ok(!getPrompt('biographer.entities').includes('{{USER_CONTEXT}}'));
  setPrompts({ 'biographer.userContext': 'Context: The user is Sim User.' });
  assert.ok(getPrompt('biographer.entities').includes('Context: The user is Sim User.'));
});

test('prompts: overriding the user context removes every default-context string', () => {
  const real = getPrompt('biographer.userContext');
  setPrompts({ 'biographer.userContext': 'Context: The user is Sim User.' });
  for (const key of [
    'biographer.entities',
    'biographer.claims',
    'biographer.sessionSummary',
    'reconcile.judge',
    'dream.entityProfile',
  ] as const) {
    assert.ok(!getPrompt(key).includes(real), `${key} still contains the default user context`);
  }
});

test('promptRegistryVersion: hashes effective text, stable, tracks overrides', () => {
  resetPrompts();
  const base = promptRegistryVersion();
  assert.match(base, /^[0-9a-f]{16}$/);
  assert.equal(promptRegistryVersion(), base);
  setPrompts({ 'biographer.userContext': 'Context: someone else.' });
  const changed = promptRegistryVersion();
  assert.notEqual(changed, base, 'a userContext override changes the effective entities prompt');
  resetPrompts();
  assert.equal(promptRegistryVersion(), base);
});

test('PROMPT_KEYS and getDefaultPrompt cover every key, unfilled', () => {
  assert.equal(PROMPT_KEYS.length, 6);
  for (const k of PROMPT_KEYS) {
    if (k !== 'biographer.userContext') assert.ok(getDefaultPrompt(k).length > 0, k);
  }
  assert.equal(getDefaultPrompt('biographer.userContext'), '', 'personal context is never in code');
  assert.ok(getDefaultPrompt('biographer.entities').includes('{{USER_CONTEXT}}'));
  setPrompts({ 'biographer.claims': 'override' });
  assert.notEqual(getDefaultPrompt('biographer.claims'), 'override');
  resetPrompts();
});

test('prompts: unknown key throws', () => {
  assert.throws(() => setPrompts({ 'biographer.nope': 'x' } as never), /unknown prompt key/);
});

test('prompts: $-patterns in the user context are inserted literally', () => {
  const ctx = "Budget $$500 and $& and $` end $'";
  setPrompts({ 'biographer.userContext': ctx });
  assert.ok(getPrompt('biographer.entities').includes(ctx));
});
