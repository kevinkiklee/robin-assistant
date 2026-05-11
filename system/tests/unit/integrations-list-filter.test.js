import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseFilter } from '../../runtime/cli/commands/integrations-list.js';

test('parseFilter returns null when no args', () => {
  assert.equal(parseFilter([]), null);
  assert.equal(parseFilter(undefined), null);
});

test('parseFilter returns first positional', () => {
  assert.equal(parseFilter(['gmail']), 'gmail');
  assert.equal(parseFilter(['list', 'gmail']), 'list');
});

test('parseFilter handles --filter <value>', () => {
  assert.equal(parseFilter(['--filter', 'spotify']), 'spotify');
  assert.equal(parseFilter(['--name', 'spotify']), 'spotify');
});

test('parseFilter handles --filter=value', () => {
  assert.equal(parseFilter(['--filter=spotify']), 'spotify');
  assert.equal(parseFilter(['--name=spotify']), 'spotify');
});

test('parseFilter --filter without value throws', () => {
  assert.throws(() => parseFilter(['--filter']), /usage:/);
  assert.throws(() => parseFilter(['--filter', '--other']), /usage:/);
});

test('parseFilter flag form wins over positional when both present', () => {
  assert.equal(parseFilter(['github', '--filter', 'gmail']), 'gmail');
});
