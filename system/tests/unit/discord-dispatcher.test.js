import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildEventFromInteraction,
  buildEventFromMessage,
  classifyMessage,
  isAllowed,
} from '../../io/integrations/discord/dispatcher.js';
import { makeInteraction, makeMessage } from '../fixtures/discord-events.js';

const allowlist = { user_ids: ['u1'], guild_ids: ['g1'], dm_user_ids: ['u1'] };

test('isAllowed: allowlisted DM passes', () => {
  const m = makeMessage({ author_id: 'u1', dm: true });
  assert.equal(isAllowed({ allowlist, message: m }), true);
});

test('isAllowed: non-allowlisted DM fails', () => {
  const m = makeMessage({ author_id: 'rando', dm: true });
  assert.equal(isAllowed({ allowlist, message: m }), false);
});

test('isAllowed: allowlisted guild + user passes', () => {
  const m = makeMessage({ author_id: 'u1', guild_id: 'g1' });
  assert.equal(isAllowed({ allowlist, message: m }), true);
});

test('isAllowed: allowlisted guild but wrong user fails', () => {
  const m = makeMessage({ author_id: 'rando', guild_id: 'g1' });
  assert.equal(isAllowed({ allowlist, message: m }), false);
});

test('isAllowed: interaction allowlist', () => {
  const i = makeInteraction({ user_id: 'u1', guild_id: 'g1' });
  assert.equal(isAllowed({ allowlist, interaction: i }), true);
});

test('classifyMessage: DM', () => {
  const m = makeMessage({ dm: true });
  assert.equal(classifyMessage(m, 'bot'), 'dm');
});

test('classifyMessage: @mention in plain channel → mention (needs new thread)', () => {
  const m = makeMessage({ mentions_bot: true });
  assert.equal(classifyMessage(m, 'bot'), 'mention');
});

test('classifyMessage: non-mention guild message → other', () => {
  const m = makeMessage({ mentions_bot: false });
  assert.equal(classifyMessage(m, 'bot'), 'other');
});

test('classifyMessage: any message in a bot-owned thread → thread', () => {
  const m = makeMessage({ mentions_bot: false, channel_kind: 'bot_thread' });
  assert.equal(classifyMessage(m, 'bot'), 'thread');
});

test('classifyMessage: bot-owned thread + @mention → thread', () => {
  const m = makeMessage({ mentions_bot: true, channel_kind: 'bot_thread' });
  assert.equal(classifyMessage(m, 'bot'), 'thread');
});

test('classifyMessage: non-mention message in another user’s thread → other', () => {
  const m = makeMessage({ mentions_bot: false, channel_kind: 'other_thread' });
  assert.equal(classifyMessage(m, 'bot'), 'other');
});

test('classifyMessage: @mention in another user’s thread still triggers reply', () => {
  const m = makeMessage({ mentions_bot: true, channel_kind: 'other_thread' });
  assert.equal(classifyMessage(m, 'bot'), 'thread');
});

test('buildEventFromMessage stamps trust=untrusted', () => {
  const m = makeMessage({ id: 'm1' });
  const e = buildEventFromMessage(m, 'mention');
  assert.equal(e.source, 'discord');
  assert.equal(e.trust, 'untrusted');
  assert.equal(e.external_id, 'm1');
});

test('buildEventFromInteraction stamps slash kind', () => {
  const i = makeInteraction({ id: 'i1', commandName: '/help' });
  const e = buildEventFromInteraction(i);
  assert.equal(e.source, 'discord');
  assert.equal(e.trust, 'untrusted');
  assert.equal(e.external_id, 'i1');
  assert.equal(e.meta.kind, 'slash');
});
