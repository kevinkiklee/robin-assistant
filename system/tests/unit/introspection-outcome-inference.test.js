// introspection-outcome-inference.test.js — pure unit tests for the three v1
// structural outcome-inference rules (no DB, no I/O).
//
// Rules under test (spec §2 "Outcome inference rules v1"):
//   1. outbound_blocked           score 0.2
//   2. recall_fingerprint_reuse   score 0.3
//   3. explicit_correction        score 0.0  (authoritative)

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildOutcomeSummary,
  inferOutcome,
} from '../../cognition/introspection/outcome-inference.js';
import { OUTCOME_INFERENCE_SCORES } from '../../cognition/introspection/inference-rules.js';

// ── Rule 1: outbound_blocked ─────────────────────────────────────────────────

test('outbound_blocked: fires when outbound_result.ok = false', () => {
  const { signals, score } = inferOutcome({
    outbound_result: { ok: false, reason: 'outbound_blocked_policy' },
  });
  assert.ok('outbound_blocked' in signals, 'signals.outbound_blocked present');
  assert.equal(signals.outbound_blocked.reason, 'outbound_blocked_policy');
  assert.equal(score, OUTCOME_INFERENCE_SCORES.outbound_blocked); // 0.2
});

test('outbound_blocked: does NOT fire when outbound_result.ok = true', () => {
  const { signals, score } = inferOutcome({
    outbound_result: { ok: true },
  });
  assert.ok(!('outbound_blocked' in signals));
  assert.equal(score, null);
});

test('outbound_blocked: does NOT fire when outbound_result absent', () => {
  const { signals } = inferOutcome({});
  assert.ok(!('outbound_blocked' in signals));
});

test('outbound_blocked: reason defaults to "unknown" when absent', () => {
  const { signals } = inferOutcome({
    outbound_result: { ok: false },
  });
  assert.equal(signals.outbound_blocked.reason, 'unknown');
});

// ── Rule 2: recall_fingerprint_reuse ─────────────────────────────────────────

test('recall_fingerprint_reuse: fires when same fingerprint, disjoint top-K', () => {
  const { signals, score } = inferOutcome({
    recall_signal: {
      fingerprint: 'fp-abc',
      top_k_ids: ['events:new1', 'events:new2'],
      session_prior_top_k_ids: ['events:old1', 'events:old2'],
    },
  });
  assert.ok('recall_fingerprint_reuse' in signals);
  assert.equal(signals.recall_fingerprint_reuse.fingerprint, 'fp-abc');
  assert.equal(score, OUTCOME_INFERENCE_SCORES.recall_fingerprint_reuse); // 0.3
});

test('recall_fingerprint_reuse: does NOT fire when top-K overlaps', () => {
  const { signals, score } = inferOutcome({
    recall_signal: {
      fingerprint: 'fp-abc',
      top_k_ids: ['events:a', 'events:b'],
      session_prior_top_k_ids: ['events:a', 'events:c'], // 'events:a' is shared
    },
  });
  assert.ok(!('recall_fingerprint_reuse' in signals));
  assert.equal(score, null);
});

test('recall_fingerprint_reuse: does NOT fire when session_prior_top_k_ids empty', () => {
  const { signals } = inferOutcome({
    recall_signal: {
      fingerprint: 'fp-abc',
      top_k_ids: ['events:new1'],
      session_prior_top_k_ids: [],
    },
  });
  assert.ok(!('recall_fingerprint_reuse' in signals));
});

test('recall_fingerprint_reuse: does NOT fire when recall_signal absent', () => {
  const { signals } = inferOutcome({});
  assert.ok(!('recall_fingerprint_reuse' in signals));
});

test('recall_fingerprint_reuse: IDs are compared as strings (record ID coercion)', () => {
  // Simulate record ID objects with different toString() representations.
  const fakeId = { toString: () => 'events:shared' };
  const { signals } = inferOutcome({
    recall_signal: {
      fingerprint: 'fp-x',
      top_k_ids: [fakeId],
      session_prior_top_k_ids: ['events:shared'],
    },
  });
  // Overlap detected via string comparison — rule should NOT fire.
  assert.ok(!('recall_fingerprint_reuse' in signals));
});

// ── Rule 3: explicit_correction_followup ─────────────────────────────────────

test('explicit_correction: fires when correction_followup.is_followup = true', () => {
  const { signals, score } = inferOutcome({
    correction_followup: { is_followup: true },
  });
  assert.ok('explicit_correction' in signals);
  assert.equal(score, OUTCOME_INFERENCE_SCORES.explicit_correction); // 0.0
});

test('explicit_correction: fires when correction_followup_sec <= window', () => {
  const { signals, score } = inferOutcome({
    correction_followup_sec: 300, // 5 min, within 10 min window
  });
  assert.ok('explicit_correction' in signals);
  assert.equal(score, 0.0);
});

test('explicit_correction: lag_sec stored in signal when provided', () => {
  const { signals } = inferOutcome({
    correction_followup_sec: 42,
  });
  assert.equal(signals.explicit_correction.lag_sec, 42);
});

test('explicit_correction: does NOT fire when correction_followup_sec exceeds window', () => {
  const { signals, score } = inferOutcome({
    correction_followup_sec: 700, // > 600s window
  });
  assert.ok(!('explicit_correction' in signals));
  assert.equal(score, null);
});

test('explicit_correction: does NOT fire when is_followup = false', () => {
  const { signals } = inferOutcome({
    correction_followup: { is_followup: false },
  });
  assert.ok(!('explicit_correction' in signals));
});

test('explicit_correction: zero-lag is within window', () => {
  const { signals } = inferOutcome({ correction_followup_sec: 0 });
  assert.ok('explicit_correction' in signals);
});

// ── Multi-rule: score is min of all firing rules ──────────────────────────────

test('score = min when multiple rules fire simultaneously', () => {
  // outbound_blocked (0.2) + explicit_correction (0.0) → min = 0.0
  const { score } = inferOutcome({
    outbound_result: { ok: false, reason: 'policy' },
    correction_followup: { is_followup: true },
  });
  assert.equal(score, 0.0);
});

test('score = 0.2 when only outbound_blocked fires', () => {
  const { score } = inferOutcome({
    outbound_result: { ok: false, reason: 'policy' },
  });
  assert.equal(score, 0.2);
});

// ── Edge cases ────────────────────────────────────────────────────────────────

test('null payload returns empty signals and null score', () => {
  const { signals, score } = inferOutcome(null);
  assert.deepEqual(signals, {});
  assert.equal(score, null);
});

test('empty payload object returns empty signals and null score', () => {
  const { signals, score } = inferOutcome({});
  assert.deepEqual(signals, {});
  assert.equal(score, null);
});

// ── buildOutcomeSummary ───────────────────────────────────────────────────────

test('buildOutcomeSummary: includes task_type, task_id, rule name, and score', () => {
  const inference = { signals: { outbound_blocked: { reason: 'policy' } }, score: 0.2 };
  const s = buildOutcomeSummary('outbound:discord_send:send_dm', 'evt-1', inference);
  assert.ok(s.includes('outbound:discord_send:send_dm'));
  assert.ok(s.includes('evt-1'));
  assert.ok(s.includes('outbound_blocked'));
  assert.ok(s.includes('0.20'));
});

test('buildOutcomeSummary: no-signal case says "no structural signals"', () => {
  const s = buildOutcomeSummary('turn:default', 't-2', { signals: {}, score: null });
  assert.ok(s.includes('no structural signals'));
  assert.ok(s.includes('score=null'));
});
