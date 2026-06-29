import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classify } from './categories.ts';
import { UNCATEGORIZED } from './config.ts';

test('valid category + explicit private', () => {
  const r = classify('Field Guides', 'private');
  assert.deepEqual(r, { ok: true, category: 'Field Guides', visibility: 'private', warnings: [] });
});

test('missing category → Uncategorized + warning, default public', () => {
  const r = classify(undefined, undefined);
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.category, UNCATEGORIZED);
    assert.equal(r.visibility, 'public');
    assert.equal(r.warnings.length, 1);
  }
});

test('empty-string category → Uncategorized + warning', () => {
  const r = classify('', '');
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.category, UNCATEGORIZED);
});

test('unknown category → reject', () => {
  const r = classify('Photograhy', undefined);
  assert.equal(r.ok, false);
});

test('invalid visibility → reject', () => {
  const r = classify('Essays', 'secret');
  assert.equal(r.ok, false);
});

test('non-string category → reject', () => {
  const r = classify(42, undefined);
  assert.equal(r.ok, false);
});
