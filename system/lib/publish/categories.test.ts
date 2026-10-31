import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classify } from './categories.ts';
import { UNCATEGORIZED } from './config.ts';

test('valid category, no visibility', () => {
  const r = classify('Field Guides', undefined);
  assert.deepEqual(r, { ok: true, category: 'Field Guides', warnings: [] });
});

test('legacy visibility: public is accepted as a no-op', () => {
  const r = classify('Essays', 'public');
  assert.deepEqual(r, { ok: true, category: 'Essays', warnings: [] });
});

test('visibility: private → reject (private pages removed)', () => {
  const r = classify('Field Guides', 'private');
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /removed/);
});

test('missing category → Uncategorized + warning', () => {
  const r = classify(undefined, undefined);
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.category, UNCATEGORIZED);
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
