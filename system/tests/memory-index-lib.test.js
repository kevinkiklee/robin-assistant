import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFrontmatter, stringifyFrontmatter } from '../scripts/lib/memory-index.js';

test('parseFrontmatter extracts description', () => {
  const input = '---\ndescription: Doctors and meds\n---\n# Medical\n\nBody.\n';
  const { frontmatter, body } = parseFrontmatter(input);
  assert.equal(frontmatter.description, 'Doctors and meds');
  assert.equal(body, '# Medical\n\nBody.\n');
});

test('parseFrontmatter returns empty frontmatter when missing', () => {
  const input = '# Medical\n\nBody.\n';
  const { frontmatter, body } = parseFrontmatter(input);
  assert.deepEqual(frontmatter, {});
  assert.equal(body, '# Medical\n\nBody.\n');
});

test('parseFrontmatter retains non-description fields', () => {
  const input = '---\ndescription: X\nfoo: bar\n---\nBody\n';
  const { frontmatter } = parseFrontmatter(input);
  assert.equal(frontmatter.description, 'X');
  assert.equal(frontmatter.foo, 'bar');
});

test('stringifyFrontmatter writes a well-formed YAML block', () => {
  const out = stringifyFrontmatter({ description: 'Hello world' }, '# Body\n');
  assert.equal(out, '---\ndescription: Hello world\n---\n# Body\n');
});

test('stringifyFrontmatter returns body unchanged when frontmatter is empty', () => {
  assert.equal(stringifyFrontmatter({}, '# Body\n'), '# Body\n');
});
