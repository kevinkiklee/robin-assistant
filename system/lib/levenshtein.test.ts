import assert from 'node:assert/strict';
import { test } from 'node:test';
import { levenshtein } from './levenshtein.ts';

test('levenshtein: identical strings → 0', () => {
  assert.equal(levenshtein('hello', 'hello'), 0);
});

test('levenshtein: empty strings', () => {
  assert.equal(levenshtein('', ''), 0);
  assert.equal(levenshtein('abc', ''), 3);
  assert.equal(levenshtein('', 'abc'), 3);
});

test('levenshtein: single substitution', () => {
  assert.equal(levenshtein('cat', 'bat'), 1);
});

test('levenshtein: insertion and deletion', () => {
  assert.equal(levenshtein('kitten', 'sitting'), 3);
});

test('levenshtein: completely different strings', () => {
  assert.equal(levenshtein('abc', 'xyz'), 3);
});
