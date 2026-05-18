import assert from 'node:assert';
import test from 'node:test';
import { COMMAND_REGISTRY, relatedFor } from '../../runtime/cli/command-registry.js';

test('every registry entry has name + summary + group', () => {
  for (const entry of COMMAND_REGISTRY) {
    assert.ok(entry.name, `entry missing name: ${JSON.stringify(entry)}`);
    assert.ok(entry.summary, `entry missing summary: ${entry.name}`);
    assert.ok(entry.group, `entry missing group: ${entry.name}`);
  }
});

test('relatedFor returns sibling names from same group, excluding self', () => {
  const related = relatedFor('jobs-list');
  assert.ok(Array.isArray(related));
  assert.ok(!related.includes('jobs-list'));
  // jobs-list should have at least one sibling (jobs-run, jobs-status, etc.)
  assert.ok(related.length > 0, `jobs-list has no related siblings — fix command-registry`);
});

test('relatedFor returns empty for unknown name', () => {
  assert.deepStrictEqual(relatedFor('nonexistent-command'), []);
});
