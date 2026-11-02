import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  distinctiveTokens,
  firstMentionIndex,
  subjectLooselyMentionedIn,
  subjectMentionedIn,
} from './match-text.ts';

test('distinctiveTokens drops stopwords, single chars, bare numbers, and generic nouns', () => {
  assert.deepEqual(distinctiveTokens('Acme stand mixer'), ['acme', 'stand', 'mixer']);
  assert.deepEqual(distinctiveTokens('Acme Bread Box'), ['acme', 'bread', 'box']);
  assert.deepEqual(distinctiveTokens('the camera lens kit'), []);
});

test('strict mention: every distinctive token must appear as a whole word', () => {
  assert.ok(subjectMentionedIn('Acme Bread Box', 'Ordered: Acme Bread Box, 2-pack'));
  assert.ok(!subjectMentionedIn('Acme Bread Box', 'Acme bread bin (generic)'));
  // Word-boundary anchored: "art" never matches "smart".
  assert.ok(!subjectMentionedIn('Art Supplies Co', 'smart supplies company'));
  // Merchant-only text never matches a product.
  assert.ok(!subjectMentionedIn('Acme stand mixer', 'Amazon'));
  assert.ok(subjectMentionedIn('Acme stand mixer', 'Acme Stand Mixer — shipped'));
});

test('strict mention: a single non-model token is too weak; a model token suffices', () => {
  assert.ok(!subjectMentionedIn('Quartz', 'Quartz falls hike'));
  assert.ok(subjectMentionedIn('ZX9', 'Your order: ZX9 dough hook'));
});

test('loose mention: ≥2 tokens (or the only one) — a candidate filter only', () => {
  assert.ok(subjectLooselyMentionedIn('Acme Bread Box', 'got the bread box'));
  assert.ok(!subjectLooselyMentionedIn('Acme Bread Box', 'my bread went stale'));
  assert.ok(subjectLooselyMentionedIn('Quartz', 'went to Quartz'));
});

test('firstMentionIndex finds the earliest whole-word token hit', () => {
  assert.equal(firstMentionIndex('Quartz Falls', 'we went to Quartz'), 10);
  assert.equal(firstMentionIndex('Quartz Falls', 'nothing here'), -1);
});
