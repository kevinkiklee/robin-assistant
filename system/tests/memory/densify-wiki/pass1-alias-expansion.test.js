import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { deriveCandidates, applyFilters } from '../../../scripts/memory/lib/alias-expander.js';

test('deriveCandidates extracts H1 and filename', () => {
  const body = `---
type: entity
aliases: [Jake]
---

# Jake Lee

Some content.
`;
  const result = deriveCandidates({ body, filename: 'jake-lee.md' });
  assert.deepEqual(result.sort(), ['Jake Lee'].sort());
});

test('deriveCandidates dedupes H1 vs. filename', () => {
  const body = `# Bay Photo Lab\n\nLab.`;
  const result = deriveCandidates({ body, filename: 'bay-photo-lab.md' });
  assert.equal(result.length, 1);
  assert.equal(result[0], 'Bay Photo Lab');
});

test('deriveCandidates handles missing H1', () => {
  const body = `No H1 in this body.`;
  const result = deriveCandidates({ body, filename: 'mt-sinai-queens.md' });
  assert.deepEqual(result, ['Mt Sinai Queens']);
});

test('deriveCandidates handles frontmatter before H1', () => {
  const body = `---\ntype: entity\n---\n# Whoop\n\nWearable.`;
  const result = deriveCandidates({ body, filename: 'whoop.md' });
  assert.deepEqual(result, ['Whoop']);
});

test('applyFilters rejects single-token candidates', () => {
  const result = applyFilters(['Mom', 'Jake Lee'], {
    existingAliases: new Set(),
    inPassRegistry: new Map(),
    stopList: new Set(),
  });
  assert.deepEqual(result.accepted, ['Jake Lee']);
  assert.deepEqual(result.rejected, [{ candidate: 'Mom', reason: 'single-token' }]);
});

test('applyFilters rejects length < 3', () => {
  const result = applyFilters(['AB CD', 'Jake Lee'], {
    existingAliases: new Set(),
    inPassRegistry: new Map(),
    stopList: new Set(),
  });
  assert.deepEqual(result.accepted, ['Jake Lee']);
  assert.equal(result.rejected.find(r => r.candidate === 'AB CD').reason, 'length-lt-3');
});

test('applyFilters rejects existing aliases (case-insensitive)', () => {
  const result = applyFilters(['Jake Lee', 'Bay Photo'], {
    existingAliases: new Set(['jake lee']),
    inPassRegistry: new Map(),
    stopList: new Set(),
  });
  assert.deepEqual(result.accepted, ['Bay Photo']);
  assert.equal(result.rejected.find(r => r.candidate === 'Jake Lee').reason, 'duplicate-self');
});

test('applyFilters rejects in-pass registry collisions', () => {
  const registry = new Map([['Jake Lee', 'profile/people/jake-lee.md']]);
  const result = applyFilters(['Jake Lee', 'Bay Photo'], {
    existingAliases: new Set(),
    inPassRegistry: registry,
    stopList: new Set(),
  });
  assert.deepEqual(result.accepted, ['Bay Photo']);
  assert.match(result.rejected.find(r => r.candidate === 'Jake Lee').reason, /collision/);
});

test('applyFilters rejects stop-list entries (whole-string, case-insensitive)', () => {
  const result = applyFilters(['Bay Photo', 'Generic Page'], {
    existingAliases: new Set(),
    inPassRegistry: new Map(),
    stopList: new Set(['generic page']),
  });
  assert.deepEqual(result.accepted, ['Bay Photo']);
  assert.equal(result.rejected.find(r => r.candidate === 'Generic Page').reason, 'stop-list');
});
