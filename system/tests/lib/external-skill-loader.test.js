import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync, mkdirSync, readFileSync, cpSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { parseSkillFrontmatter, validateSkill, scanSkills, generateIndex, loadInstalledManifest, writeInstalledManifest, addManifestEntry, removeManifestEntry, lightScan } from '../../scripts/lib/external-skill-loader.js';

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

function makeWorkspace() {
  const ws = mkdtempSync(join(tmpdir(), 'robin-skill-test-'));
  mkdirSync(join(ws, 'user-data', 'skills', 'external'), { recursive: true });
  return ws;
}

describe('external-skill-loader: scanSkills', () => {
  it('returns empty array when external/ is empty or missing', () => {
    const ws = makeWorkspace();
    try {
      assert.deepEqual(scanSkills(ws), []);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('returns valid skills and skips invalid ones', () => {
    const ws = makeWorkspace();
    const ext = join(ws, 'user-data', 'skills', 'external');
    cpSync(join(FIXTURES, 'valid-basic'), join(ext, 'valid-basic'), { recursive: true });
    cpSync(join(FIXTURES, 'invalid-no-description'), join(ext, 'invalid-no-description'), { recursive: true });
    try {
      const skills = scanSkills(ws);
      assert.equal(skills.length, 1);
      assert.equal(skills[0].name, 'valid-basic');
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});

describe('external-skill-loader: generateIndex', () => {
  it('writes INDEX.md atomically with one entry per valid skill', () => {
    const ws = makeWorkspace();
    const ext = join(ws, 'user-data', 'skills', 'external');
    cpSync(join(FIXTURES, 'valid-basic'), join(ext, 'valid-basic'), { recursive: true });
    cpSync(join(FIXTURES, 'valid-with-aliases'), join(ext, 'valid-with-aliases'), { recursive: true });
    try {
      generateIndex(ws);
      const idx = readFileSync(join(ext, 'INDEX.md'), 'utf8');
      assert.match(idx, /# External skills installed/);
      assert.match(idx, /\*\*valid-basic\*\* — A minimal valid skill/);
      assert.match(idx, /\*\*valid-with-aliases\*\* — A skill with trigger aliases/);
      assert.match(idx, /Triggered by "extract article", "fetch article"/);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('writes empty INDEX.md when no skills installed', () => {
    const ws = makeWorkspace();
    try {
      generateIndex(ws);
      const idx = readFileSync(join(ws, 'user-data', 'skills', 'external', 'INDEX.md'), 'utf8');
      assert.match(idx, /# External skills installed/);
      assert.match(idx, /_no skills installed_/);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});

describe('external-skill-loader: installed-skills.json', () => {
  it('returns default empty manifest when file is missing', () => {
    const ws = makeWorkspace();
    try {
      const m = loadInstalledManifest(ws);
      assert.equal(m.schemaVersion, 1);
      assert.deepEqual(m.skills, []);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('writeInstalledManifest creates parent dir and persists', () => {
    const ws = makeWorkspace();
    try {
      writeInstalledManifest(ws, {
        schemaVersion: 1,
        skills: [{ name: 'x', source: 'foo', commit: 'abc', installedAt: '2026-05-04', trust: 'untrusted-mixed' }],
      });
      const m = loadInstalledManifest(ws);
      assert.equal(m.skills.length, 1);
      assert.equal(m.skills[0].name, 'x');
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('addManifestEntry appends and persists', () => {
    const ws = makeWorkspace();
    try {
      addManifestEntry(ws, { name: 'a', source: 'foo', commit: '1', installedAt: '2026-05-04', trust: 'untrusted-mixed' });
      addManifestEntry(ws, { name: 'b', source: 'bar', commit: '2', installedAt: '2026-05-04', trust: 'untrusted-mixed' });
      const m = loadInstalledManifest(ws);
      assert.equal(m.skills.length, 2);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('removeManifestEntry removes by name', () => {
    const ws = makeWorkspace();
    try {
      addManifestEntry(ws, { name: 'a', source: 'foo', commit: '1', installedAt: '2026-05-04', trust: 'untrusted-mixed' });
      addManifestEntry(ws, { name: 'b', source: 'bar', commit: '2', installedAt: '2026-05-04', trust: 'untrusted-mixed' });
      removeManifestEntry(ws, 'a');
      const m = loadInstalledManifest(ws);
      assert.equal(m.skills.length, 1);
      assert.equal(m.skills[0].name, 'b');
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('returns default empty manifest if file is malformed JSON', () => {
    const ws = makeWorkspace();
    const path = join(ws, 'user-data', 'runtime', 'state', 'installed-skills.json');
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '{ not json');
    try {
      const m = loadInstalledManifest(ws);
      assert.equal(m.schemaVersion, 1);
      assert.deepEqual(m.skills, []);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('addManifestEntry upserts by name (no duplicates on re-add)', () => {
    const ws = makeWorkspace();
    try {
      addManifestEntry(ws, { name: 'a', source: 'foo', commit: '1', installedAt: '2026-05-04', trust: 'untrusted-mixed' });
      addManifestEntry(ws, { name: 'a', source: 'foo', commit: '2', installedAt: '2026-05-05', trust: 'untrusted-mixed' });
      const m = loadInstalledManifest(ws);
      assert.equal(m.skills.length, 1);
      assert.equal(m.skills[0].commit, '2');
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('addManifestEntry keeps skills sorted alphabetically', () => {
    const ws = makeWorkspace();
    try {
      addManifestEntry(ws, { name: 'c', source: 'foo', commit: '1', installedAt: '2026-05-04', trust: 'untrusted-mixed' });
      addManifestEntry(ws, { name: 'a', source: 'bar', commit: '2', installedAt: '2026-05-04', trust: 'untrusted-mixed' });
      addManifestEntry(ws, { name: 'b', source: 'baz', commit: '3', installedAt: '2026-05-04', trust: 'untrusted-mixed' });
      const m = loadInstalledManifest(ws);
      assert.deepEqual(m.skills.map((s) => s.name), ['a', 'b', 'c']);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});

describe('external-skill-loader: lightScan', () => {
  it('returns no warnings on a clean skill', () => {
    const result = lightScan(join(FIXTURES, 'valid-basic'));
    assert.equal(result.warnings.length, 0);
  });

  it('warns when a script references credential paths', () => {
    const result = lightScan(join(FIXTURES, 'has-suspicious-script'));
    assert.ok(result.warnings.length > 0);
    assert.match(result.warnings.join('\n'), /credential|\.aws|secret/i);
  });

  it('warns when SKILL.md contains a bash-sensitive pattern', () => {
    const result = lightScan(join(FIXTURES, 'has-bash-pattern'));
    assert.ok(result.warnings.length > 0);
    assert.match(result.warnings.join('\n'), /bash-sensitive pattern/);
  });
});
