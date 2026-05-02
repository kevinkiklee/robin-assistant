import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { deriveCandidates } from '../../../scripts/memory/lib/alias-expander.js';

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
