import assert from 'node:assert/strict';
import { test } from 'node:test';
import { categoryForSlug } from './backfill-publish-categories.ts';

test('rule-based slugs', () => {
  assert.equal(categoryForSlug('lens-nikon-z-50mm-f1-8-s'), 'Lens Analysis');
  assert.equal(categoryForSlug('critique-2026-06-24'), 'Critiques');
  assert.equal(categoryForSlug('color-grade-dockmaster-wall'), 'Color Grading');
  assert.equal(categoryForSlug('trading-prd-analysis'), 'Projects');
  assert.equal(categoryForSlug('tc-1-4x-fullres-3'), 'Gear & Comparisons');
  assert.equal(categoryForSlug('nikon-z50ii-100-400-vs-180-600-vs-500pf'), 'Gear & Comparisons');
});

test('override-mapped slugs', () => {
  assert.equal(categoryForSlug('jamaica-bay-sunrise-birding'), 'Field Guides');
  assert.equal(categoryForSlug('ugreen-nas-setup-guide'), 'Tools & Setup');
  assert.equal(categoryForSlug('photographer-profile'), 'Essays');
});

test('unknown slug falls back to Uncategorized', () => {
  assert.equal(categoryForSlug('something-totally-new-2099'), 'Uncategorized');
});
