import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ANTECEDENT_KINDS,
  CORRECTION_REGEXES,
  INTROSPECTION_DEFAULTS,
  OUTCOME_INFERENCE_SCORES,
  OUTCOME_INFERENCE_WINDOWS,
} from '../../cognition/introspection/inference-rules.js';

// --- CORRECTION_REGEXES ---

const CORRECTION_MATCHES = [
  'no that is wrong',
  'nope',
  'wrong answer',
  'actually I meant something else',
  'wait, let me rethink',
  'instead do this',
  'i meant the other one',
  'i mean the first option',
  '1. no that works',
  '2. not correct',
  'a',
  'b.',
  'c',
  'd.',
  'e',
];

const CORRECTION_NON_MATCHES = [
  'yes that is correct',
  'great job',
  'sounds good',
  'please continue',
  'ok',
  'f', // only a-e are valid single-letter overrides
  'g.',
  'maybe not',
];

test('CORRECTION_REGEXES match expected correction strings', () => {
  for (const str of CORRECTION_MATCHES) {
    const matched = CORRECTION_REGEXES.some((re) => re.test(str));
    assert.ok(matched, `expected a correction regex to match: ${JSON.stringify(str)}`);
  }
});

test('CORRECTION_REGEXES do not match non-correction strings', () => {
  for (const str of CORRECTION_NON_MATCHES) {
    const matched = CORRECTION_REGEXES.some((re) => re.test(str));
    assert.ok(!matched, `expected no correction regex to match: ${JSON.stringify(str)}`);
  }
});

test('CORRECTION_REGEXES is an array of RegExp', () => {
  assert.ok(Array.isArray(CORRECTION_REGEXES));
  assert.ok(CORRECTION_REGEXES.length > 0);
  for (const re of CORRECTION_REGEXES) {
    assert.ok(re instanceof RegExp);
  }
});

// --- ANTECEDENT_KINDS ---

test('ANTECEDENT_KINDS.STRONG contains documented entries', () => {
  assert.ok(Array.isArray(ANTECEDENT_KINDS.STRONG));
  assert.ok(ANTECEDENT_KINDS.STRONG.includes('ask_user_question_call'));
  assert.ok(ANTECEDENT_KINDS.STRONG.includes('predict_call'));
});

test('ANTECEDENT_KINDS.WEAK contains documented entries', () => {
  assert.ok(Array.isArray(ANTECEDENT_KINDS.WEAK));
  assert.ok(ANTECEDENT_KINDS.WEAK.includes('numbered_list_ge2'));
  assert.ok(ANTECEDENT_KINDS.WEAK.includes('ends_with_question_mark'));
  assert.ok(ANTECEDENT_KINDS.WEAK.includes('outbound_write_performed'));
});

// --- OUTCOME_INFERENCE_WINDOWS ---

test('OUTCOME_INFERENCE_WINDOWS has documented time values', () => {
  assert.equal(OUTCOME_INFERENCE_WINDOWS.correction_followup_window_sec, 600);
});

// --- OUTCOME_INFERENCE_SCORES ---

test('OUTCOME_INFERENCE_SCORES has documented values', () => {
  assert.equal(OUTCOME_INFERENCE_SCORES.outbound_blocked, 0.2);
  assert.equal(OUTCOME_INFERENCE_SCORES.recall_fingerprint_reuse, 0.3);
  assert.equal(OUTCOME_INFERENCE_SCORES.explicit_correction, 0.0);
});

// --- INTROSPECTION_DEFAULTS ---

test('INTROSPECTION_DEFAULTS shape is preserved', () => {
  assert.equal(INTROSPECTION_DEFAULTS.daily_cost_budget_usd, 0.50);
  assert.equal(INTROSPECTION_DEFAULTS.turn_sample_pct_floor, 5);
  assert.equal(INTROSPECTION_DEFAULTS.turn_sample_pct_ceiling, 50);
  assert.equal(INTROSPECTION_DEFAULTS.target_turn_spend_fraction, 0.5);
  assert.equal(INTROSPECTION_DEFAULTS.crash_count_restart_threshold, 5);

  // leaky_bucket_decay_per_sec is 1/60 — use approx comparison
  assert.ok(
    Math.abs(INTROSPECTION_DEFAULTS.leaky_bucket_decay_per_sec - 1 / 60) < 1e-10,
    'leaky_bucket_decay_per_sec should be 1/60',
  );

  const thresholds = INTROSPECTION_DEFAULTS.budget_remaining_thresholds;
  assert.ok(thresholds && typeof thresholds === 'object');
  assert.equal(thresholds.recall_throttle_at, 0.25);
  assert.equal(thresholds.antecedent_regex_fallback_at, 0.25);
  assert.equal(thresholds.turn_sample_cutoff_at, 0.10);
});
