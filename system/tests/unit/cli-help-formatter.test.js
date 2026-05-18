import test from 'node:test';
import assert from 'node:assert';
import { appendRelated } from '../../runtime/cli/help-formatter.js';

test('appendRelated adds Related: line when command has siblings', () => {
  const out = appendRelated('usage: jobs-list', 'jobs-list');
  assert.match(out, /\n\nRelated: .+/);
  assert.match(out, /jobs-run/);
});

test('appendRelated leaves text untouched when no siblings', () => {
  const out = appendRelated('usage: nonexistent-command', 'nonexistent-command');
  assert.strictEqual(out, 'usage: nonexistent-command');
});
