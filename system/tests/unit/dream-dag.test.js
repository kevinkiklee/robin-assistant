import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DREAM_DAG_DEPS } from '../../cognition/dream/dag.js';
import { byName } from '../../cognition/dream/step-registry.js';

test('DREAM_DAG_DEPS keys match step-registry byName keys (bidirectional)', () => {
  const a = new Set(Object.keys(byName));
  const b = new Set(Object.keys(DREAM_DAG_DEPS));
  const missingFromDeps = [...a].filter((k) => !b.has(k));
  const missingFromRegistry = [...b].filter((k) => !a.has(k));
  assert.deepEqual(missingFromDeps, [], `keys in byName not in deps: ${missingFromDeps}`);
  assert.deepEqual(missingFromRegistry, [], `keys in deps not in byName: ${missingFromRegistry}`);
});

test('expected camelCase keys are present', () => {
  const expected = [
    'knowledge',
    'patterns',
    'reflection',
    'profile',
    'arcs',
    'commStyle',
    'scopeCleanup',
    'calibration',
    'compaction',
  ].sort();
  assert.deepEqual(Object.keys(DREAM_DAG_DEPS).sort(), expected);
  assert.deepEqual(Object.keys(byName).sort(), expected);
});

test('every dep edge references a known step', () => {
  const known = new Set(Object.keys(DREAM_DAG_DEPS));
  for (const [name, deps] of Object.entries(DREAM_DAG_DEPS)) {
    for (const d of deps) {
      assert.ok(known.has(d), `${name} depends on unknown step '${d}'`);
    }
  }
});

test('topoLayers(byName, DREAM_DAG_DEPS) returns three layers with expected membership', async () => {
  const { topoLayers } = await import('../../cognition/dream/scheduler.js');
  const layers = topoLayers(byName, DREAM_DAG_DEPS);
  assert.equal(layers.length, 3);
  // Layer 1: knowledge, patterns, reflection, profile, arcs, commStyle
  assert.deepEqual([...layers[0]].sort(), [
    'arcs',
    'commStyle',
    'knowledge',
    'patterns',
    'profile',
    'reflection',
  ]);
  // Layer 2: scopeCleanup, calibration
  assert.deepEqual([...layers[1]].sort(), ['calibration', 'scopeCleanup']);
  // Layer 3: compaction
  assert.deepEqual([...layers[2]].sort(), ['compaction']);
});
