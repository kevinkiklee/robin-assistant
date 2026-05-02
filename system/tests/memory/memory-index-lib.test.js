import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseFrontmatter,
  stringifyFrontmatter,
  slugify,
  disambiguateSlug,
  countContentLines,
  rewriteLinks,
  parseHeadings,
  proposeDomainRoots,
  sectionSizes,
} from '../../scripts/memory/lib/memory-index.js';

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

test('slugify lowercases and dasherizes', () => {
  assert.equal(slugify('Healthcare providers'), 'healthcare-providers');
});

test('slugify strips punctuation and parens', () => {
  assert.equal(
    slugify('Pubbed (Events/Pubbed) — selected/published frames'),
    'pubbed-eventspubbed-selectedpublished-frames'
  );
});

test('slugify collapses consecutive dashes and trims', () => {
  assert.equal(slugify('  ---hello---world---  '), 'hello-world');
});

test('slugify drops non-ASCII', () => {
  assert.equal(slugify('Café résumé'), 'caf-rsum');
});

test('disambiguateSlug appends -2, -3 on collision', () => {
  const used = new Set(['identity']);
  assert.equal(disambiguateSlug('identity', used), 'identity-2');
  used.add('identity-2');
  assert.equal(disambiguateSlug('identity', used), 'identity-3');
});

test('disambiguateSlug returns original when no collision', () => {
  assert.equal(disambiguateSlug('x', new Set()), 'x');
});

test('countContentLines excludes blank lines', () => {
  assert.equal(countContentLines('a\n\nb\n\n\nc\n'), 3);
});

test('countContentLines excludes frontmatter block', () => {
  const input = '---\ndescription: x\n---\na\nb\n';
  assert.equal(countContentLines(input), 2);
});

test('countContentLines includes comment and code-fence lines', () => {
  const input = '<!-- comment -->\n```\ncode\n```\n';
  assert.equal(countContentLines(input), 4);
});

test('countContentLines returns 0 for frontmatter-only input', () => {
  assert.equal(countContentLines('---\ndescription: x\n---\n'), 0);
});

test('rewriteLinks rewrites a relative markdown link', () => {
  const input = 'See [people](../profile/people.md) for context.';
  const renames = new Map([['profile/people.md', 'profile/people/family.md']]);
  const out = rewriteLinks(input, renames, 'knowledge/medical.md');
  assert.equal(out, 'See [people](../profile/people/family.md) for context.');
});

test('rewriteLinks leaves absolute and anchor links alone', () => {
  const input = 'See [external](https://example.com) and [anchor](#section).';
  const renames = new Map([['profile/people.md', 'profile/people/family.md']]);
  const out = rewriteLinks(input, renames, 'knowledge/medical.md');
  assert.equal(out, input);
});

test('rewriteLinks handles multiple renames in one document', () => {
  const input = '[a](../a.md) and [b](../b.md)';
  const renames = new Map([
    ['a.md', 'a/x.md'],
    ['b.md', 'b/y.md'],
  ]);
  const out = rewriteLinks(input, renames, 'sub/file.md');
  assert.equal(out, '[a](../a/x.md) and [b](../b/y.md)');
});

test('rewriteLinks leaves unrelated links alone', () => {
  const input = '[other](../other.md)';
  const renames = new Map([['a.md', 'a/x.md']]);
  const out = rewriteLinks(input, renames, 'sub/file.md');
  assert.equal(out, input);
});

test('parseHeadings finds headings level 2 and deeper with line numbers', () => {
  const input = '# Top\n\n## A\nbody\n## B\nbody\n### C\nbody\n## D\n';
  const out = parseHeadings(input);
  assert.deepEqual(out, [
    { level: 2, title: 'A', line: 3 },
    { level: 2, title: 'B', line: 5 },
    { level: 3, title: 'C', line: 7 },
    { level: 2, title: 'D', line: 9 },
  ]);
});

test('parseHeadings ignores headings inside fenced code', () => {
  const input = '```\n## not a heading\n```\n## real\n';
  const out = parseHeadings(input);
  assert.deepEqual(out, [{ level: 2, title: 'real', line: 4 }]);
});

test('proposeDomainRoots: first level-2 always root, small-section headings are children', () => {
  const headings = [
    { level: 2, title: 'Locations', line: 4 },
    { level: 2, title: 'Medical', line: 24 },
    { level: 2, title: 'Notes', line: 77 },
    { level: 2, title: 'Photography-collection', line: 125 },
  ];
  // Section sizes (content lines from this heading to the next):
  // Locations: 20, Medical: 53, Notes: 48, Photography-collection: 1100
  const sizes = new Map([[4, 20], [24, 53], [77, 48], [125, 1100]]);
  const roots = proposeDomainRoots(headings, sizes, { childThreshold: 50 });
  const rootLines = roots.map(r => r.line);
  // First (Locations) always root. Medical (53) is root. Notes (48 < 50) is child.
  // Photography-collection (1100) is root.
  assert.deepEqual(rootLines, [4, 24, 125]);
});

test('proposeDomainRoots ignores level-3 headings', () => {
  const headings = [
    { level: 2, title: 'A', line: 1 },
    { level: 3, title: 'A.1', line: 5 },
    { level: 2, title: 'B', line: 100 },
  ];
  const sizes = new Map([[1, 100], [100, 100]]);
  const roots = proposeDomainRoots(headings, sizes, { childThreshold: 50 });
  assert.deepEqual(roots.map(r => r.title), ['A', 'B']);
});

test('sectionSizes computes content lines per level-2 section', () => {
  const input = '# Top\n## A\nx\ny\n## B\nz\n\n\n## C\n';
  const sizes = sectionSizes(input);
  assert.equal(sizes.get(2), 3);   // ## A + x + y
  assert.equal(sizes.get(5), 2);   // ## B + z
  assert.equal(sizes.get(9), 1);   // ## C
});
