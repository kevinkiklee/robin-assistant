import assert from 'node:assert/strict';
import { test } from 'node:test';
import { score } from '../../cognition/intuition/rank.js';

const baseHit = () => ({
  record: {
    kind: 'knowledge',
    confidence: 0.8,
    signal_count: 2,
    decay_anchor: new Date(Date.now() - 86400_000).toISOString(),
    derived_by: 'manual',
    source: undefined,
    scope: 'global',
  },
  distance: 0.2,
});

test('score(hit) defaults entityBoost=1.0 (regression guard)', () => {
  const a = score(baseHit());
  const b = score(baseHit(), { entityBoost: 1.0 });
  assert.ok(Math.abs(a.score - b.score) < 1e-9);
  assert.equal(a.components.entityBoost, 1.0);
  assert.equal(a.components.entityBoostCount, 0);
});

test('score(hit, {entityBoost: 1.25}) multiplies total by 1.25', () => {
  const baseline = score(baseHit());
  const boosted = score(baseHit(), { entityBoost: 1.25, entityBoostCount: 2 });
  assert.ok(Math.abs(boosted.score - baseline.score * 1.25) < 1e-9);
  assert.equal(boosted.components.entityBoost, 1.25);
  assert.equal(boosted.components.entityBoostCount, 2);
});

test('score: entityBoost stacks multiplicatively with scopeBoost', () => {
  const hit = baseHit();
  hit.record.scope = 'project:foo';
  const a = score(hit, { scope: 'project:foo' }); // scopeBoost=1.2
  const b = score(hit, { scope: 'project:foo', entityBoost: 1.25 });
  assert.ok(Math.abs(b.score - a.score * 1.25) < 1e-9);
});
