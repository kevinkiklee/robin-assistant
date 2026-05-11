import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseArgs } from '../../runtime/cli/args.js';

test('parseArgs: positional command', () => {
  assert.deepEqual(parseArgs(['migrate']), { _: ['migrate'], flags: {} });
});

test('parseArgs: long flag with value', () => {
  assert.deepEqual(parseArgs(['migrate', '--verbose', '--limit', '5']), {
    _: ['migrate'],
    flags: { verbose: true, limit: '5' },
  });
});

test('parseArgs: equals form', () => {
  assert.deepEqual(parseArgs(['--limit=10']), { _: [], flags: { limit: '10' } });
});

test('parseArgs: short flag', () => {
  assert.deepEqual(parseArgs(['-v']), { _: [], flags: { v: true } });
});
