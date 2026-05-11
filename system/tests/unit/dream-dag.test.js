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
  assert.deepEqual(
    missingFromRegistry,
    [],
    `keys in deps not in byName: ${missingFromRegistry}`,
  );
});

test('expected camelCase keys are present', () => {
  const expected = [
    'knowledge',
    'patterns',
    'reflection',
    'profile',
    'arcs',
    'commStyle',
    'confidence',
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
