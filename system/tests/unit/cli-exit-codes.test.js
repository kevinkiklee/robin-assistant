import test from 'node:test';
import assert from 'node:assert';
import { EXIT_CODES, describeExit } from '../../runtime/cli/exit-codes.js';

test('EXIT_CODES has the four canonical values', () => {
  assert.strictEqual(EXIT_CODES.OK, 0);
  assert.strictEqual(EXIT_CODES.ERROR, 1);
  assert.strictEqual(EXIT_CODES.USER_ERROR, 2);
  assert.strictEqual(EXIT_CODES.PRECONDITION, 3);
});

test('describeExit returns canonical name for known code', () => {
  assert.strictEqual(describeExit(0), 'OK');
  assert.strictEqual(describeExit(2), 'USER_ERROR');
  assert.strictEqual(describeExit(3), 'PRECONDITION');
});

test('describeExit returns "ERROR" for unknown code', () => {
  assert.strictEqual(describeExit(99), 'ERROR');
});
