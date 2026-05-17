// Unit tests for correction-inference.js
// Pure logic — no DB, no file I/O.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  classifyAntecedent,
  inferCorrection,
  matchesCorrectionPattern,
} from '../../cognition/intuition/correction-inference.js';

// ─── matchesCorrectionPattern ────────────────────────────────────────────────

test('matchesCorrectionPattern: "no" matches', () => {
  assert.equal(matchesCorrectionPattern('no'), true);
});

test('matchesCorrectionPattern: "No that is wrong" matches', () => {
  assert.equal(matchesCorrectionPattern('No that is wrong'), true);
});

test('matchesCorrectionPattern: "nope" matches', () => {
  assert.equal(matchesCorrectionPattern('nope, try again'), true);
});

test('matchesCorrectionPattern: "wrong" matches', () => {
  assert.equal(matchesCorrectionPattern('wrong answer'), true);
});

test('matchesCorrectionPattern: "actually" matches', () => {
  assert.equal(matchesCorrectionPattern('actually I meant the other one'), true);
});

test('matchesCorrectionPattern: "wait" matches', () => {
  assert.equal(matchesCorrectionPattern('wait, that is not right'), true);
});

test('matchesCorrectionPattern: "instead" matches', () => {
  assert.equal(matchesCorrectionPattern('instead use option B'), true);
});

test('matchesCorrectionPattern: "i meant" matches', () => {
  assert.equal(matchesCorrectionPattern('i meant the third option'), true);
});

test('matchesCorrectionPattern: "i mean" matches', () => {
  assert.equal(matchesCorrectionPattern('i mean the one with stars'), true);
});

test('matchesCorrectionPattern: digit + no matches', () => {
  assert.equal(matchesCorrectionPattern('1. no not that'), true);
  assert.equal(matchesCorrectionPattern('2 not the second'), true);
});

test('matchesCorrectionPattern: digit + not matches', () => {
  assert.equal(matchesCorrectionPattern('3. not right'), true);
});

test('matchesCorrectionPattern: single letter a-e matches', () => {
  assert.equal(matchesCorrectionPattern('a'), true);
  assert.equal(matchesCorrectionPattern('b'), true);
  assert.equal(matchesCorrectionPattern('c.'), true);
  assert.equal(matchesCorrectionPattern('e'), true);
});

test('matchesCorrectionPattern: letter outside a-e does NOT match third pattern', () => {
  // 'f' is not in the a-e range
  assert.equal(matchesCorrectionPattern('f'), false);
});

test('matchesCorrectionPattern: empty string returns false', () => {
  assert.equal(matchesCorrectionPattern(''), false);
});

test('matchesCorrectionPattern: null returns false', () => {
  assert.equal(matchesCorrectionPattern(null), false);
});

test('matchesCorrectionPattern: undefined returns false', () => {
  assert.equal(matchesCorrectionPattern(undefined), false);
});

test('matchesCorrectionPattern: normal affirmation does not match', () => {
  assert.equal(matchesCorrectionPattern('sounds good'), false);
  assert.equal(matchesCorrectionPattern('yes please'), false);
  assert.equal(matchesCorrectionPattern('great'), false);
});

test('matchesCorrectionPattern: leading whitespace is trimmed', () => {
  assert.equal(matchesCorrectionPattern('   no   '), true);
});

test('matchesCorrectionPattern: case insensitive', () => {
  assert.equal(matchesCorrectionPattern('NO'), true);
  assert.equal(matchesCorrectionPattern('ACTUALLY'), true);
  assert.equal(matchesCorrectionPattern('Wrong'), true);
});

// ─── classifyAntecedent ──────────────────────────────────────────────────────

test('classifyAntecedent: AskUserQuestion call = STRONG ask_user_question_call', () => {
  const result = classifyAntecedent({
    text: '',
    tool_calls: [{ name: 'AskUserQuestion' }],
  });
  assert.ok(result.strong.includes('ask_user_question_call'));
  assert.equal(result.qualifies, true);
});

test('classifyAntecedent: AskUserQuestion case-insensitive via lowercase', () => {
  const result = classifyAntecedent({
    text: '',
    tool_calls: [{ name: 'askuserquestion' }],
  });
  assert.ok(result.strong.includes('ask_user_question_call'));
  assert.equal(result.qualifies, true);
});

test('classifyAntecedent: predict call = STRONG predict_call', () => {
  const result = classifyAntecedent({
    text: '',
    tool_calls: [{ name: 'predict' }],
  });
  assert.ok(result.strong.includes('predict_call'));
  assert.equal(result.qualifies, true);
});

test('classifyAntecedent: mcp__robin__predict = STRONG predict_call', () => {
  const result = classifyAntecedent({
    text: '',
    tool_calls: [{ name: 'mcp__robin__predict' }],
  });
  assert.ok(result.strong.includes('predict_call'));
  assert.equal(result.qualifies, true);
});

test('classifyAntecedent: numbered list ≥2 items = WEAK numbered_list_ge2', () => {
  const result = classifyAntecedent({
    text: '1. Option one\n2. Option two',
    tool_calls: [],
  });
  assert.ok(result.weak.includes('numbered_list_ge2'));
});

test('classifyAntecedent: numbered list exactly 1 item = no weak signal', () => {
  const result = classifyAntecedent({
    text: '1. Only one item',
    tool_calls: [],
  });
  assert.ok(!result.weak.includes('numbered_list_ge2'));
});

test('classifyAntecedent: ends with ? = WEAK ends_with_question_mark', () => {
  const result = classifyAntecedent({
    text: 'Which option do you prefer?',
    tool_calls: [],
  });
  assert.ok(result.weak.includes('ends_with_question_mark'));
});

test('classifyAntecedent: does not end with ? = no ends_with_question_mark', () => {
  const result = classifyAntecedent({
    text: 'Here is the answer.',
    tool_calls: [],
  });
  assert.ok(!result.weak.includes('ends_with_question_mark'));
});

test('classifyAntecedent: discord_send = WEAK outbound_write_performed', () => {
  const result = classifyAntecedent({
    text: '',
    tool_calls: [{ name: 'discord_send' }],
  });
  assert.ok(result.weak.includes('outbound_write_performed'));
});

test('classifyAntecedent: mcp__robin__discord_send = WEAK outbound_write_performed', () => {
  const result = classifyAntecedent({
    text: '',
    tool_calls: [{ name: 'mcp__robin__discord_send' }],
  });
  assert.ok(result.weak.includes('outbound_write_performed'));
});

test('classifyAntecedent: github_write = WEAK outbound_write_performed', () => {
  const result = classifyAntecedent({
    text: '',
    tool_calls: [{ name: 'github_write' }],
  });
  assert.ok(result.weak.includes('outbound_write_performed'));
});

test('classifyAntecedent: spotify_write = WEAK outbound_write_performed', () => {
  const result = classifyAntecedent({
    text: '',
    tool_calls: [{ name: 'spotify_write' }],
  });
  assert.ok(result.weak.includes('outbound_write_performed'));
});

test('classifyAntecedent: two weak signals qualifies', () => {
  const result = classifyAntecedent({
    text: '1. A\n2. B\nWhich do you prefer?',
    tool_calls: [],
  });
  // numbered_list_ge2 + ends_with_question_mark
  assert.ok(result.weak.includes('numbered_list_ge2'));
  assert.ok(result.weak.includes('ends_with_question_mark'));
  assert.equal(result.qualifies, true);
});

test('classifyAntecedent: one weak signal does NOT qualify', () => {
  const result = classifyAntecedent({
    text: 'Here is the result.',
    tool_calls: [{ name: 'discord_send' }],
  });
  assert.equal(result.weak.length, 1);
  assert.equal(result.strong.length, 0);
  assert.equal(result.qualifies, false);
});

test('classifyAntecedent: no signals = does not qualify', () => {
  const result = classifyAntecedent({
    text: 'Here is the answer.',
    tool_calls: [],
  });
  assert.equal(result.strong.length, 0);
  assert.equal(result.weak.length, 0);
  assert.equal(result.qualifies, false);
});

test('classifyAntecedent: strong + weak both present = qualifies', () => {
  const result = classifyAntecedent({
    text: 'Which do you prefer?',
    tool_calls: [{ name: 'AskUserQuestion' }],
  });
  assert.ok(result.strong.includes('ask_user_question_call'));
  assert.ok(result.weak.includes('ends_with_question_mark'));
  assert.equal(result.qualifies, true);
});

test('classifyAntecedent: null input = does not qualify', () => {
  const result = classifyAntecedent(null);
  assert.equal(result.qualifies, false);
  assert.equal(result.strong.length, 0);
  assert.equal(result.weak.length, 0);
});

test('classifyAntecedent: missing tool_calls field = treated as empty', () => {
  const result = classifyAntecedent({ text: '' });
  assert.equal(result.strong.length, 0);
  assert.equal(result.qualifies, false);
});

test('classifyAntecedent: tool_calls with null entry is tolerated', () => {
  const result = classifyAntecedent({
    text: '',
    tool_calls: [null, { name: 'AskUserQuestion' }],
  });
  assert.ok(result.strong.includes('ask_user_question_call'));
  assert.equal(result.qualifies, true);
});

test('classifyAntecedent: all three weak signals qualifies', () => {
  const result = classifyAntecedent({
    text: '1. A\n2. B\nWhich?',
    tool_calls: [{ name: 'discord_send' }],
  });
  assert.ok(result.weak.includes('numbered_list_ge2'));
  assert.ok(result.weak.includes('ends_with_question_mark'));
  assert.ok(result.weak.includes('outbound_write_performed'));
  assert.equal(result.qualifies, true);
});

// ─── inferCorrection ─────────────────────────────────────────────────────────

test('inferCorrection: fires when pattern matches + antecedent qualifies (strong)', () => {
  const result = inferCorrection({
    userText: 'no that is wrong',
    priorTurn: { text: '', tool_calls: [{ name: 'AskUserQuestion' }] },
  });
  assert.equal(result.fires, true);
  assert.ok(result.signals);
  assert.equal(result.signals.matched_pattern, true);
  assert.equal(result.signals.antecedent.qualifies, true);
});

test('inferCorrection: does not fire when pattern matches but antecedent unqualified', () => {
  const result = inferCorrection({
    userText: 'no',
    priorTurn: { text: 'Here is the plain answer.', tool_calls: [] },
  });
  assert.equal(result.fires, false);
  assert.equal(result.reason, 'antecedent_unqualified');
});

test('inferCorrection: does not fire when pattern does not match even if antecedent qualifies', () => {
  const result = inferCorrection({
    userText: 'sounds good to me',
    priorTurn: { text: '', tool_calls: [{ name: 'AskUserQuestion' }] },
  });
  assert.equal(result.fires, false);
  assert.equal(result.reason, 'no_pattern_match');
});

test('inferCorrection: fires with two weak signals', () => {
  const result = inferCorrection({
    userText: 'actually option 2',
    priorTurn: {
      text: '1. Option A\n2. Option B\nWhich do you prefer?',
      tool_calls: [],
    },
  });
  assert.equal(result.fires, true);
  assert.ok(result.signals.antecedent.weak.length >= 2);
});

test('inferCorrection: empty userText = no_pattern_match', () => {
  const result = inferCorrection({
    userText: '',
    priorTurn: { text: '', tool_calls: [{ name: 'AskUserQuestion' }] },
  });
  assert.equal(result.fires, false);
  assert.equal(result.reason, 'no_pattern_match');
});

test('inferCorrection: null priorTurn = antecedent_unqualified', () => {
  const result = inferCorrection({
    userText: 'no',
    priorTurn: null,
  });
  assert.equal(result.fires, false);
  assert.equal(result.reason, 'antecedent_unqualified');
});

test('inferCorrection: undefined priorTurn = antecedent_unqualified', () => {
  const result = inferCorrection({
    userText: 'wrong',
    priorTurn: undefined,
  });
  assert.equal(result.fires, false);
  assert.equal(result.reason, 'antecedent_unqualified');
});

test('inferCorrection: single letter "b" fires when AskUserQuestion present', () => {
  const result = inferCorrection({
    userText: 'b',
    priorTurn: { text: '', tool_calls: [{ name: 'AskUserQuestion' }] },
  });
  assert.equal(result.fires, true);
});

test('inferCorrection: "i meant" fires with predict call', () => {
  const result = inferCorrection({
    userText: 'i meant that the event would not occur',
    priorTurn: { text: '', tool_calls: [{ name: 'mcp__robin__predict' }] },
  });
  assert.equal(result.fires, true);
});
