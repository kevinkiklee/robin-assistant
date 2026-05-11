import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  computeSignalHash,
  detectChange,
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
  const priorHash = computeSignalHash({ entities: ['entities:a'], arc_id: 'arcs:x', last_event_id: null });
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
