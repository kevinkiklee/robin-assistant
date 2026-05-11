import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildPrompt,
  clampConfidence,
  computeSignalHash,
  detectChange,
  validateLLMOutput,
} from '../../cognition/jobs/internal/state-inference.js';

test('computeSignalHash is stable across entity ordering', () => {
  const h1 = computeSignalHash({
    entities: ['entities:a', 'entities:b', 'entities:c'],
    arc_id: 'arcs:x',
    last_event_id: 'events:1',
  });
  const h2 = computeSignalHash({
    entities: ['entities:c', 'entities:a', 'entities:b'],
    arc_id: 'arcs:x',
    last_event_id: 'events:1',
  });
  assert.equal(h1, h2);
});

test('computeSignalHash differs when arc_id changes', () => {
  const h1 = computeSignalHash({ entities: ['entities:a'], arc_id: 'arcs:x', last_event_id: null });
  const h2 = computeSignalHash({ entities: ['entities:a'], arc_id: 'arcs:y', last_event_id: null });
  assert.notEqual(h1, h2);
});

test('detectChange: no prior → materially_changed=true, reason=no_prior', () => {
  const r = detectChange({
    prior: null,
    current: { entities: [], arc_id: null, last_event_id: null },
    now: new Date(),
    refreshAfterMinutes: 30,
  });
  assert.equal(r.materially_changed, true);
  assert.equal(r.reason, 'no_prior');
  assert.equal(typeof r.signal_hash, 'string');
});

test('detectChange: same hash + fresh → materially_changed=false', () => {
  const sig = computeSignalHash({ entities: ['entities:a'], arc_id: null, last_event_id: null });
  const prior = {
    meta: {
      signal_hash: sig,
      last_active_at: new Date(Date.now() - 5 * 60_000).toISOString(),
    },
  };
  const r = detectChange({
    prior,
    current: { entities: ['entities:a'], arc_id: null, last_event_id: null },
    now: new Date(),
    refreshAfterMinutes: 30,
  });
  assert.equal(r.materially_changed, false);
  assert.equal(r.reason, 'unchanged');
  assert.equal(r.signal_hash, sig);
});

test('detectChange: hash differs → materially_changed=true, reason=hash_differs', () => {
  const oldSig = computeSignalHash({ entities: ['entities:a'], arc_id: null, last_event_id: null });
  const prior = {
    meta: { signal_hash: oldSig, last_active_at: new Date().toISOString() },
  };
  const r = detectChange({
    prior,
    current: { entities: ['entities:b'], arc_id: null, last_event_id: null },
    now: new Date(),
    refreshAfterMinutes: 30,
  });
  assert.equal(r.materially_changed, true);
  assert.equal(r.reason, 'hash_differs');
});

test('detectChange: prior older than refresh window → materially_changed=true, reason=refresh_window', () => {
  const sig = computeSignalHash({ entities: ['entities:a'], arc_id: null, last_event_id: null });
  const stale = new Date(Date.now() - 45 * 60_000);
  const prior = { meta: { signal_hash: sig, last_active_at: stale.toISOString() } };
  const r = detectChange({
    prior,
    current: { entities: ['entities:a'], arc_id: null, last_event_id: null },
    now: new Date(),
    refreshAfterMinutes: 30,
  });
  assert.equal(r.materially_changed, true);
  assert.equal(r.reason, 'refresh_window');
});

test('detectChange: entities unchanged + arc changed only → materially_changed=true', () => {
  const priorHash = computeSignalHash({
    entities: ['entities:a'],
    arc_id: 'arcs:x',
    last_event_id: null,
  });
  const prior = {
    meta: { signal_hash: priorHash, last_active_at: new Date().toISOString() },
  };
  const r = detectChange({
    prior,
    current: { entities: ['entities:a'], arc_id: 'arcs:y', last_event_id: null },
    now: new Date(),
    refreshAfterMinutes: 30,
  });
  assert.equal(r.materially_changed, true);
  assert.equal(r.reason, 'hash_differs');
});

test('detectChange: entities unchanged + last_event_id changed only → materially_changed=true', () => {
  const priorHash = computeSignalHash({
    entities: ['entities:a'],
    arc_id: null,
    last_event_id: 'events:1',
  });
  const prior = {
    meta: { signal_hash: priorHash, last_active_at: new Date().toISOString() },
  };
  const r = detectChange({
    prior,
    current: { entities: ['entities:a'], arc_id: null, last_event_id: 'events:2' },
    now: new Date(),
    refreshAfterMinutes: 30,
  });
  assert.equal(r.materially_changed, true);
  assert.equal(r.reason, 'hash_differs');
});

test('detectChange: entities + arc + last_event_id all unchanged + time threshold crossed → materially_changed=true', () => {
  const sig = computeSignalHash({
    entities: ['entities:a'],
    arc_id: 'arcs:x',
    last_event_id: 'events:1',
  });
  // 31 min ago, with refreshAfterMinutes=30 — only the time threshold has
  // crossed; every other input is identical.
  const prior = {
    meta: {
      signal_hash: sig,
      last_active_at: new Date(Date.now() - 31 * 60_000).toISOString(),
    },
  };
  const r = detectChange({
    prior,
    current: { entities: ['entities:a'], arc_id: 'arcs:x', last_event_id: 'events:1' },
    now: new Date(),
    refreshAfterMinutes: 30,
  });
  assert.equal(r.materially_changed, true);
  assert.equal(r.reason, 'refresh_window');
});

test('buildPrompt includes arc summary, entities, events, prior content', () => {
  const out = buildPrompt({
    arc: { summary: 'Refactor cognition layer' },
    entities: [{ name: 'state_inference', type: 'topic' }],
    events: [{ ts: '2026-05-11T18:00:00Z', content: 'wrote design spec' }],
    prior: { content: 'iterating on cognition refactor' },
  });
  assert.match(out, /Refactor cognition layer/);
  assert.match(out, /state_inference/);
  assert.match(out, /wrote design spec/);
  assert.match(out, /iterating on cognition refactor/);
  assert.match(out, /Respond JSON only:/);
});

test('buildPrompt handles null arc + empty prior gracefully', () => {
  const out = buildPrompt({
    arc: null,
    entities: [],
    events: [{ ts: '2026-05-11T18:00:00Z', content: 'noop' }],
    prior: null,
  });
  assert.match(out, /Active arc: none/);
  assert.match(out, /Prior inference \(for context, may be stale\): none/);
});

test('clampConfidence respects [0.05, 0.95] bounds and ambiguous shrink', () => {
  assert.equal(clampConfidence(1.5, false), 0.95);
  assert.equal(clampConfidence(-0.3, false), 0.05);
  assert.equal(clampConfidence(0.8, true), 0.4);
  assert.equal(clampConfidence(0.5, false), 0.5);
});

test('validateLLMOutput rejects non-JSON or missing fields', () => {
  assert.equal(validateLLMOutput(null).ok, false);
  assert.equal(validateLLMOutput({ focus_statement: 'x' }).ok, false); // missing confidence
  const v = validateLLMOutput({
    focus_statement: 'x',
    confidence: 0.7,
    evidence_snippet: 's',
    ambiguous: false,
    drop: false,
  });
  assert.equal(v.ok, true);
});
