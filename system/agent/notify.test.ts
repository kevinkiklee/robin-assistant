import assert from 'node:assert/strict';
import { test } from 'node:test';
import { notifyExhaustion } from './notify.ts';

test('notifyExhaustion: dispatches a "switch accounts" notification for pool exhaustion', async () => {
  const calls: Array<{ title: string; message: string }> = [];
  const res = await notifyExhaustion('pool-exhausted', {
    notify: async (p) => {
      calls.push(p);
      return { delivered: true };
    },
  });

  assert.equal(res.delivered, true);
  assert.equal(calls.length, 1);
  assert.match(calls[0].title, /Robin/i);
  // The actionable instruction is to switch accounts in the Claude TUI.
  assert.match(calls[0].message, /switch accounts/i);
  assert.match(calls[0].message, /Claude/i);
});

test('notifyExhaustion: maps an auth-limit reason to the same actionable guidance', async () => {
  const calls: Array<{ title: string; message: string }> = [];
  await notifyExhaustion('auth-limit', {
    notify: async (p) => {
      calls.push(p);
      return { delivered: true };
    },
  });
  assert.match(calls[0].message, /switch accounts/i);
});

test('notifyExhaustion: surfaces a non-delivery from the notifier', async () => {
  const res = await notifyExhaustion('pool-exhausted', {
    notify: async () => ({ delivered: false, reason: 'no display' }),
  });
  assert.equal(res.delivered, false);
  assert.equal(res.reason, 'no display');
});
