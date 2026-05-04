import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseSkillFrontmatter } from '../../scripts/lib/external-skill-loader.js';

describe('external-skill-loader: parseSkillFrontmatter', () => {
  it('parses name and description from frontmatter', () => {
    const content = `---
name: article-extractor
description: Extract full article text and metadata from web pages.
---

# Article Extractor

body content
`;
    const { frontmatter, body } = parseSkillFrontmatter(content);
    assert.equal(frontmatter.name, 'article-extractor');
    assert.equal(frontmatter.description, 'Extract full article text and metadata from web pages.');
    assert.match(body, /# Article Extractor/);
  });

  it('parses trigger-aliases as an array', () => {
    const content = `---
name: x
description: y
trigger-aliases:
  - "extract article"
  - "fetch article"
---
body
`;
    const { frontmatter } = parseSkillFrontmatter(content);
    assert.deepEqual(frontmatter['trigger-aliases'], ['extract article', 'fetch article']);
  });

  it('returns empty frontmatter and full body when no frontmatter present', () => {
    const content = '# Just markdown\n\nNo frontmatter.';
    const { frontmatter, body } = parseSkillFrontmatter(content);
    assert.deepEqual(frontmatter, {});
    assert.equal(body, content);
  });

  it('handles inline-array trigger-aliases', () => {
    const content = `---
name: x
description: y
trigger-aliases: ["a", "b"]
---
body
`;
    const { frontmatter } = parseSkillFrontmatter(content);
    assert.deepEqual(frontmatter['trigger-aliases'], ['a', 'b']);
  });
});
