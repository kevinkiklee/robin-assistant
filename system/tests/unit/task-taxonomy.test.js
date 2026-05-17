import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  RECALL_INTENTS,
  TASK_TYPE_PREFIXES,
  TOKEN_CAPS,
  TURN_INTENTS,
  parseTaskType,
  tokenCapForTaskType,
  validateTaskType,
} from '../../cognition/introspection/task-taxonomy.js';

// --- parseTaskType ---

test('parseTaskType splits prefix and rest', () => {
  assert.deepEqual(parseTaskType('turn:recommend'), { prefix: 'turn', rest: 'recommend' });
  assert.deepEqual(parseTaskType('recall:person'), { prefix: 'recall', rest: 'person' });
  assert.deepEqual(parseTaskType('job:daily-briefing'), { prefix: 'job', rest: 'daily-briefing' });
  assert.deepEqual(parseTaskType('outbound:discord_send:send_dm'), {
    prefix: 'outbound',
    rest: 'discord_send:send_dm',
  });
});

test('parseTaskType returns null for bad input', () => {
  assert.equal(parseTaskType('no-colon'), null);
  assert.equal(parseTaskType(':no-prefix'), null);
  assert.equal(parseTaskType('prefix:'), null);
  assert.equal(parseTaskType(null), null);
  assert.equal(parseTaskType(42), null);
  assert.equal(parseTaskType(''), null);
});

// --- validateTaskType — valid cases ---

test('validateTaskType accepts all TURN_INTENTS', () => {
  for (const intent of TURN_INTENTS) {
    const result = validateTaskType(`turn:${intent}`);
    assert.ok(result.ok, `expected ok for turn:${intent}, got: ${result.reason}`);
  }
});

test('validateTaskType accepts all RECALL_INTENTS', () => {
  for (const intent of RECALL_INTENTS) {
    const result = validateTaskType(`recall:${intent}`);
    assert.ok(result.ok, `expected ok for recall:${intent}, got: ${result.reason}`);
  }
});

test('validateTaskType accepts job and outbound with arbitrary rest', () => {
  assert.ok(validateTaskType('job:daily-briefing').ok);
  assert.ok(validateTaskType('job:health-trends').ok);
  assert.ok(validateTaskType('outbound:discord_send:send_dm').ok);
  assert.ok(validateTaskType('outbound:github_write:create-issue').ok);
});

// --- validateTaskType — invalid cases ---

test('validateTaskType rejects unknown prefix', () => {
  const result = validateTaskType('unknown:something');
  assert.equal(result.ok, false);
  assert.ok(result.reason.includes('unknown prefix'));
});

test('validateTaskType rejects bad turn intent', () => {
  const result = validateTaskType('turn:hallucinate');
  assert.equal(result.ok, false);
  assert.ok(result.reason.includes('turn intent'));
});

test('validateTaskType rejects bad recall intent', () => {
  const result = validateTaskType('recall:something_made_up');
  assert.equal(result.ok, false);
  assert.ok(result.reason.includes('recall intent'));
});

test('validateTaskType rejects non-string and missing colon', () => {
  assert.equal(validateTaskType('nocolon').ok, false);
  assert.equal(validateTaskType('').ok, false);
  assert.equal(validateTaskType(null).ok, false);
});

// --- tokenCapForTaskType ---

test('tokenCapForTaskType returns the right cap for each prefix', () => {
  for (const prefix of TASK_TYPE_PREFIXES) {
    // Use a valid task_type per prefix
    const taskType =
      prefix === 'turn'
        ? 'turn:default'
        : prefix === 'recall'
          ? 'recall:default'
          : `${prefix}:anything`;
    const cap = tokenCapForTaskType(taskType);
    assert.equal(cap, TOKEN_CAPS[prefix], `expected ${TOKEN_CAPS[prefix]} for ${taskType}`);
  }
});

test('tokenCapForTaskType returns null for bad input', () => {
  assert.equal(tokenCapForTaskType('nocolon'), null);
  assert.equal(tokenCapForTaskType('unknown:rest'), null);
  assert.equal(tokenCapForTaskType(null), null);
});
