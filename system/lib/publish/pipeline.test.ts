import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractFrontmatter, normalizeMarkdown } from './pipeline.ts';

test('extractFrontmatter: parses YAML frontmatter and returns body', () => {
  const src = '---\ntitle: My Post\nslug: foo\n---\n# Heading\n\nbody text';
  const { frontmatter, body } = extractFrontmatter(src);
  assert.equal(frontmatter.title, 'My Post');
  assert.equal(frontmatter.slug, 'foo');
  assert.equal(body, '# Heading\n\nbody text');
});

test('extractFrontmatter: no frontmatter returns empty object + full body', () => {
  const src = '# Heading\n\nbody';
  const { frontmatter, body } = extractFrontmatter(src);
  assert.deepEqual(frontmatter, {});
  assert.equal(body, src);
});

test('normalizeMarkdown: strips BOM and converts CRLF to LF', () => {
  const src = `﻿line1\r\nline2\r\n`;
  const out = normalizeMarkdown(src);
  assert.equal(out, 'line1\nline2\n');
  assert.ok(out.charCodeAt(0) !== 0xfeff);
});

test('normalizeMarkdown: leaves clean input untouched', () => {
  const src = 'already\nlf\nnewlines';
  assert.equal(normalizeMarkdown(src), src);
});
