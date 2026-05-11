import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildFocusBlock,
  evaluateFocusSuppression,
  humaniseDuration,
} from '../../cognition/intuition/inject.js';

test('humaniseDuration: 23m, 4h, 2d', () => {
  assert.equal(humaniseDuration(23 * 60_000), '23m');
  assert.equal(humaniseDuration(4 * 3_600_000), '4h');
  assert.equal(humaniseDuration(2 * 86_400_000), '2d');
  assert.equal(humaniseDuration(0), '0m');
});

test('buildFocusBlock renders frame + body + arc short id', () => {
  const ts = new Date(Date.now() - 23 * 60_000);
  const memo = {
    id: 'memos:abc',
    content: 'Kevin is refactoring cognition',
    confidence: 0.8,
    meta: {
      last_active_at: ts.toISOString(),
      arc_id: 'arcs:01HZABCDEFGHIJK',
    },
  };
  const block = buildFocusBlock(memo, { now: new Date() });
  assert.match(block, /<!-- current focus -->/);
  assert.match(block, /<!-- \/current focus -->/);
  assert.match(block, /\[focus, last active 23m ago, conf 0\.80\]/);
  assert.match(block, /Kevin is refactoring cognition/);
  assert.match(block, /arc:arcs:01HZABCDEFGHIJK/);
});

test('buildFocusBlock omits arc tag when arc_id is null', () => {
  const memo = {
    content: 'something',
    confidence: 0.6,
    meta: { last_active_at: new Date().toISOString(), arc_id: null },
  };
  const block = buildFocusBlock(memo, { now: new Date() });
  assert.doesNotMatch(block, /arc:/);
});

test('suppression rule 1: enabled !== true → suppressed=disabled', () => {
  const r = evaluateFocusSuppression({
    cfg: { enabled: 'shadow' },
    memo: null,
    query: '',
    now: new Date(),
  });
  assert.equal(r.suppressed, 'disabled');
});

test('suppression rule 2: no memo → no_memo', () => {
  const r = evaluateFocusSuppression({
    cfg: { enabled: true },
    memo: null,
    query: '',
    now: new Date(),
  });
  assert.equal(r.suppressed, 'no_memo');
});

test('suppression rule 3: confidence below floor → low_confidence', () => {
  const memo = {
    confidence: 0.3,
    meta: { last_active_at: new Date().toISOString(), entities: [] },
  };
  const r = evaluateFocusSuppression({
    cfg: { enabled: true, min_confidence_to_surface: 0.5, stale_after_minutes: 120 },
    memo,
    query: 'anything',
    now: new Date(),
  });
  assert.equal(r.suppressed, 'low_confidence');
});

test('suppression rule 4: stale → stale', () => {
  const memo = {
    confidence: 0.8,
    meta: { last_active_at: new Date(Date.now() - 4 * 3_600_000).toISOString(), entities: [] },
  };
  const r = evaluateFocusSuppression({
    cfg: { enabled: true, min_confidence_to_surface: 0.5, stale_after_minutes: 120 },
    memo,
    query: 'anything',
    now: new Date(),
  });
  assert.equal(r.suppressed, 'stale');
});

test('suppression rule 7: scope=private → private', () => {
  const memo = {
    confidence: 0.8,
    scope: 'private',
    content: 'secret',
    meta: { last_active_at: new Date().toISOString(), entities: [] },
  };
  const r = evaluateFocusSuppression({
    cfg: { enabled: true, min_confidence_to_surface: 0.5, stale_after_minutes: 120 },
    memo,
    query: 'secret',
    now: new Date(),
  });
  assert.equal(r.suppressed, 'private');
});

test('suppression rule 6: zero keyword overlap → pivot', () => {
  const memo = {
    confidence: 0.8,
    content: 'Kevin is refactoring cognition layer',
    meta: {
      last_active_at: new Date().toISOString(),
      entities: ['entities:cognition_refactor'],
    },
  };
  const r = evaluateFocusSuppression({
    cfg: { enabled: true, min_confidence_to_surface: 0.5, stale_after_minutes: 120 },
    memo,
    query: 'lunch plans tomorrow',
    now: new Date(),
  });
  assert.equal(r.suppressed, 'pivot');
});

test('all rules pass → suppressed=null', () => {
  const memo = {
    confidence: 0.8,
    content: 'Kevin is refactoring cognition layer',
    meta: {
      last_active_at: new Date().toISOString(),
      entities: ['entities:cognition_refactor'],
    },
  };
  const r = evaluateFocusSuppression({
    cfg: { enabled: true, min_confidence_to_surface: 0.5, stale_after_minutes: 120 },
    memo,
    query: 'how is the cognition refactoring going?',
    now: new Date(),
  });
  assert.equal(r.suppressed, null);
});
