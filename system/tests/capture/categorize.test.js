import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRules, categorize, categorizeAll, summarizeByCategory } from '../../scripts/lib/categorize.js';

function writeRules(content) {
  const dir = mkdtempSync(join(tmpdir(), 'categorize-'));
  const path = join(dir, 'rules.md');
  writeFileSync(path, content);
  return { dir, path };
}

test('loadRules parses the Rules section only', () => {
  const { dir, path } = writeRules(`---
description: test
---

# Categorization Rules

## Categories used

- Income
- Shopping

## Rules

| pattern | match type | category |
|---|---|---|
| GOOGLE LLC PAYROLL | substring | Income |
| Whole Foods | substring | Food: Groceries |
| /chase card/i | regex | Internal |

## Notes

| ignored | row | here |
`);
  const { rules } = loadRules(path);
  assert.equal(rules.length, 3);
  assert.deepEqual(rules[0], { pattern: 'GOOGLE LLC PAYROLL', matchType: 'substring', category: 'Income' });
  assert.equal(rules[2].matchType, 'regex');
  rmSync(dir, { recursive: true, force: true });
});

test('categorize: substring match (case-insensitive)', () => {
  const rules = [{ pattern: 'whole foods', matchType: 'substring', category: 'Food: Groceries' }];
  const result = categorize({ payee: 'WHOLE FOODS MARKET' }, rules);
  assert.equal(result.category, 'Food: Groceries');
  assert.equal(result.source, 'rule');
});

test('categorize: regex match', () => {
  const rules = [{ pattern: '/payment to .*chase card/i', matchType: 'regex', category: 'Internal' }];
  const result = categorize({ payee: 'Payment to Chase card ending in 1427' }, rules);
  assert.equal(result.category, 'Internal');
});

test('categorize: exact match', () => {
  const rules = [{ pattern: 'Steam', matchType: 'exact', category: 'Subscriptions: Gaming' }];
  assert.equal(categorize({ payee: 'Steam' }, rules).category, 'Subscriptions: Gaming');
  assert.notEqual(categorize({ payee: 'Steamworks' }, rules).category, 'Subscriptions: Gaming');
});

test('categorize: first-match-wins ordering', () => {
  const rules = [
    { pattern: 'Amazon', matchType: 'substring', category: 'Shopping' },
    { pattern: 'Amazon Pharmacy', matchType: 'substring', category: 'Healthcare' },
  ];
  // Even though Pharmacy is more specific, Shopping comes first → wins
  assert.equal(categorize({ payee: 'Amazon Pharmacy auto-refill' }, rules).category, 'Shopping');
});

test('categorize: falls back to LM category', () => {
  const result = categorize({ payee: 'Some Random Payee', category: '🍔 Restaurants' }, []);
  assert.equal(result.category, 'Restaurants');
  assert.equal(result.source, 'lunch-money');
});

test('categorize: falls back to Uncategorized when nothing matches', () => {
  const result = categorize({ payee: 'Mystery' }, []);
  assert.equal(result.category, 'Uncategorized');
  assert.equal(result.source, 'fallback');
});

test('summarizeByCategory aggregates totals and counts, sorts descending', () => {
  const rules = [
    { pattern: 'Rent', matchType: 'substring', category: 'Housing' },
    { pattern: 'Whole Foods', matchType: 'substring', category: 'Food' },
  ];
  const enriched = categorizeAll(
    [
      { payee: 'Rent', amount: 3200 },
      { payee: 'Whole Foods', amount: 80 },
      { payee: 'Whole Foods', amount: 45 },
    ],
    rules
  );
  const summary = summarizeByCategory(enriched);
  assert.equal(summary[0].category, 'Housing');
  assert.equal(summary[0].total, 3200);
  assert.equal(summary[0].count, 1);
  assert.equal(summary[1].category, 'Food');
  assert.equal(summary[1].total, 125);
  assert.equal(summary[1].count, 2);
});

test('loadRules ignores rows with invalid match types', () => {
  const { dir, path } = writeRules(`# Rules
## Rules
| pattern | match type | category |
|---|---|---|
| Foo | nonsense | Bar |
| Baz | substring | Qux |
`);
  const { rules } = loadRules(path);
  assert.equal(rules.length, 1);
  assert.equal(rules[0].pattern, 'Baz');
  rmSync(dir, { recursive: true, force: true });
});

test('loadRules parses Category remaps section', () => {
  const { dir, path } = writeRules(`# Rules

## Rules

| pattern | match type | category |
|---|---|---|
| Whole Foods | substring | Food: Groceries |

## Category remaps

| LM category | Robin category |
|---|---|
| Hotels | Travel |
| Payment, Transfer | Internal |
`);
  const { rules, remaps } = loadRules(path);
  assert.equal(rules.length, 1);
  assert.equal(remaps.get('hotels'), 'Travel');
  assert.equal(remaps.get('payment, transfer'), 'Internal');
  rmSync(dir, { recursive: true, force: true });
});

test('categorize: applies remap when no payee rule matches', () => {
  const bundle = { rules: [], remaps: new Map([['hotels', 'Travel']]) };
  const result = categorize({ payee: 'Marriott NYC', category: '🏨 Hotels' }, bundle);
  assert.equal(result.category, 'Travel');
  assert.equal(result.source, 'remap');
});

test('categorize: payee rule wins over remap', () => {
  const bundle = {
    rules: [{ pattern: 'Marriott', matchType: 'substring', category: 'Travel: Hotel' }],
    remaps: new Map([['hotels', 'Travel']]),
  };
  const result = categorize({ payee: 'Marriott NYC', category: 'Hotels' }, bundle);
  assert.equal(result.category, 'Travel: Hotel');
  assert.equal(result.source, 'rule');
});

test('categorize: backward-compatible with rules-only array input', () => {
  const result = categorize({ payee: 'Whole Foods' }, [
    { pattern: 'Whole Foods', matchType: 'substring', category: 'Food' },
  ]);
  assert.equal(result.category, 'Food');
});
