import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { extractSection, normalizeForHash, hashHardRules } from '../scripts/lib/agentsmd-hash.js';

const SAMPLE = `# Agents

intro paragraph.

## Hard Rules

- **Privacy.** Block writes containing full SSNs.
- **Verification.** Verify before declaring urgent.

## Operational Rules

other rules.
`;

test('extractSection: returns the body of a named section', () => {
  const out = extractSection(SAMPLE, 'Hard Rules');
  assert.match(out, /Privacy/);
  assert.match(out, /Verification/);
  assert.doesNotMatch(out, /Operational Rules/);
});

test('extractSection: returns null for missing section', () => {
  assert.equal(extractSection(SAMPLE, 'Nonexistent'), null);
});

test('extractSection: requires exactly two # — # or ### do not match', () => {
  const md = `# Hard Rules\n\nbody1\n\n### Hard Rules\n\nbody2\n`;
  assert.equal(extractSection(md, 'Hard Rules'), null);
});

test('extractSection: handles last section in document', () => {
  const md = `## Hard Rules\n\nthe body\n\nlast line.`;
  const out = extractSection(md, 'Hard Rules');
  assert.match(out, /the body/);
  assert.match(out, /last line/);
});

test('normalizeForHash: collapses blank-line runs', () => {
  const n = normalizeForHash('a\n\n\n\nb\n\n\nc');
  assert.equal(n, 'a\n\nb\n\nc');
});

test('normalizeForHash: strips trailing whitespace per line', () => {
  const n = normalizeForHash('hello   \nworld    ');
  assert.equal(n, 'hello\nworld');
});

test('normalizeForHash: trims leading/trailing blanks', () => {
  const n = normalizeForHash('\n\n  hello\n\n');
  assert.equal(n, 'hello');
});

test('hashHardRules: stable across trailing-whitespace and triple-blank-line cosmetic edits', () => {
  // Per the normalize policy: trailing whitespace per line stripped; 3+ blank
  // lines collapse to a single blank line; structural blank lines are
  // preserved. Adding/removing actual paragraph breaks is a semantic change.
  const a = `## Hard Rules\n\nrule one.\n\nrule two.\n`;
  const b = `## Hard Rules\n\n\n\nrule one.   \n\n\nrule two.\n\n\n`;
  assert.equal(hashHardRules(a), hashHardRules(b));
});

test('hashHardRules: different on semantic edits', () => {
  const a = `## Hard Rules\n\nrule one.\n`;
  const b = `## Hard Rules\n\nrule one. extra.\n`;
  assert.notEqual(hashHardRules(a), hashHardRules(b));
});

test('hashHardRules: returns null when section missing', () => {
  assert.equal(hashHardRules('# Title\n\nbody only.'), null);
});
