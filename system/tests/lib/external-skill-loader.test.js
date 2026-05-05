import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSkillFrontmatter, validateSkill } from '../../scripts/lib/external-skill-loader.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../fixtures/external-skills');

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

describe('external-skill-loader: validateSkill', () => {
  it('accepts a valid skill folder', () => {
    const result = validateSkill(join(FIXTURES, 'valid-basic'));
    assert.equal(result.ok, true);
    assert.equal(result.skill.name, 'valid-basic');
  });

  it('rejects when SKILL.md is missing', () => {
    const result = validateSkill(join(FIXTURES, 'does-not-exist'));
    assert.equal(result.ok, false);
    assert.match(result.reason, /SKILL\.md not found/);
  });

  it('rejects when description is missing', () => {
    const result = validateSkill(join(FIXTURES, 'invalid-no-description'));
    assert.equal(result.ok, false);
    assert.match(result.reason, /description/);
  });

  it('rejects when name does not match folder', () => {
    const result = validateSkill(join(FIXTURES, 'invalid-name-mismatch'));
    assert.equal(result.ok, false);
    assert.match(result.reason, /name.*folder/);
  });

  it('rejects when override is set', () => {
    const result = validateSkill(join(FIXTURES, 'invalid-with-override'));
    assert.equal(result.ok, false);
    assert.match(result.reason, /override/);
  });
});
