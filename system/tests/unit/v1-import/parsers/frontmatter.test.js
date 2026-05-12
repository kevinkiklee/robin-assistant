import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseFrontmatter } from '../../../../runtime/install/v1-import/parsers/frontmatter.js';

test('parseFrontmatter: returns body when no frontmatter', () => {
  const { frontmatter, body } = parseFrontmatter('# Hello\n\nbody text');
  assert.equal(frontmatter, null);
  assert.equal(body, '# Hello\n\nbody text');
});

test('parseFrontmatter: extracts simple keys', () => {
  const src = [
    '---',
    'description: Test doc',
    'type: topic',
    'decay: medium',
    '---',
    '# Hello',
  ].join('\n');
  const { frontmatter, body } = parseFrontmatter(src);
  assert.deepEqual(frontmatter, { description: 'Test doc', type: 'topic', decay: 'medium' });
  assert.equal(body, '# Hello');
});

test('parseFrontmatter: coerces booleans, numbers, null', () => {
  const src = ['---', 'a: true', 'b: false', 'c: 42', 'd: 3.14', 'e: ~', '---', ''].join('\n');
  const { frontmatter } = parseFrontmatter(src);
  assert.equal(frontmatter.a, true);
  assert.equal(frontmatter.b, false);
  assert.equal(frontmatter.c, 42);
  assert.equal(frontmatter.d, 3.14);
  assert.equal(frontmatter.e, null);
});

test('parseFrontmatter: strips one set of quotes', () => {
  const src = `---\nfoo: "quoted"\nbar: 'single'\n---\n`;
  const { frontmatter } = parseFrontmatter(src);
  assert.equal(frontmatter.foo, 'quoted');
  assert.equal(frontmatter.bar, 'single');
});

test('parseFrontmatter: keeps ISO dates as strings', () => {
  const src = '---\nlast_verified: 2026-05-08\n---\nbody';
  const { frontmatter } = parseFrontmatter(src);
  assert.equal(frontmatter.last_verified, '2026-05-08');
});

test('parseFrontmatter: ignores comments and blank lines inside fence', () => {
  const src = '---\n# a comment\n\nkey: val\n---\nx';
  const { frontmatter } = parseFrontmatter(src);
  assert.deepEqual(frontmatter, { key: 'val' });
});

test('parseFrontmatter: handles non-string input', () => {
  assert.deepEqual(parseFrontmatter(null), { frontmatter: null, body: '' });
  assert.deepEqual(parseFrontmatter(undefined), { frontmatter: null, body: '' });
});
