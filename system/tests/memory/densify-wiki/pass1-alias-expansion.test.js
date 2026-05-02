import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { deriveCandidates, applyFilters, shouldFlipType, expandAliases } from '../../../scripts/memory/lib/alias-expander.js';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function tempWorkspace() {
  const dir = mkdtempSync(join(tmpdir(), 'densify-test-'));
  mkdirSync(join(dir, 'user-data', 'memory', 'profile', 'people'), { recursive: true });
  mkdirSync(join(dir, 'user-data', 'memory', 'knowledge', 'service-providers'), { recursive: true });
  return dir;
}

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

test('applyFilters rejects whole-string length < 3', () => {
  const result = applyFilters(['AB', 'Jake Lee'], {
    existingAliases: new Set(),
    inPassRegistry: new Map(),
    stopList: new Set(),
  });
  assert.deepEqual(result.accepted, ['Jake Lee']);
  assert.equal(result.rejected.find(r => r.candidate === 'AB').reason, 'length-lt-3');
});

test('applyFilters accepts disambiguator suffixes (e.g., "Jake Jr")', () => {
  const result = applyFilters(['Jake Jr'], {
    existingAliases: new Set(),
    inPassRegistry: new Map(),
    stopList: new Set(),
  });
  assert.deepEqual(result.accepted, ['Jake Jr']);
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

test('shouldFlipType flips entity-shaped dir + aliases + type:topic', () => {
  assert.equal(shouldFlipType({ relPath: 'profile/people/jake-lee.md', currentType: 'topic', hasAliases: true }), true);
  assert.equal(shouldFlipType({ relPath: 'knowledge/projects/photobot.md', currentType: 'topic', hasAliases: true }), true);
  assert.equal(shouldFlipType({ relPath: 'knowledge/service-providers/abco.md', currentType: 'topic', hasAliases: true }), true);
  assert.equal(shouldFlipType({ relPath: 'knowledge/locations/home.md', currentType: 'topic', hasAliases: true }), true);
});

test('shouldFlipType does NOT flip type:snapshot/analysis/event/source', () => {
  for (const t of ['snapshot', 'analysis', 'event', 'source']) {
    assert.equal(shouldFlipType({ relPath: 'profile/people/jake-lee.md', currentType: t, hasAliases: true }), false, `type:${t} must not flip`);
  }
});

test('shouldFlipType does NOT flip when not in entity-shaped dir', () => {
  assert.equal(shouldFlipType({ relPath: 'knowledge/medical/back-spine.md', currentType: 'topic', hasAliases: true }), false);
  assert.equal(shouldFlipType({ relPath: 'journal.md', currentType: 'topic', hasAliases: true }), false);
});

test('shouldFlipType does NOT flip when no aliases', () => {
  assert.equal(shouldFlipType({ relPath: 'profile/people/jake-lee.md', currentType: 'topic', hasAliases: false }), false);
});

test('shouldFlipType does NOT flip when already type:entity', () => {
  assert.equal(shouldFlipType({ relPath: 'profile/people/jake-lee.md', currentType: 'entity', hasAliases: true }), false);
});

test('expandAliases writes additions to entity-shaped files atomically', async () => {
  const ws = tempWorkspace();
  try {
    const filePath = join(ws, 'user-data/memory/profile/people/jake-lee.md');
    writeFileSync(filePath, `---\ntype: topic\naliases: [Jake]\n---\n\n# Jake Lee\n\nBrother.\n`);

    const result = await expandAliases({ workspaceDir: ws, stopList: new Set() });

    const after = readFileSync(filePath, 'utf-8');
    assert.match(after, /aliases: \["Jake", "Jake Lee"\]/);
    assert.match(after, /type: entity/);
    assert.equal(result.filesModified.length, 1);
    assert.deepEqual(result.summary.aliasesAdded, 1);
    assert.deepEqual(result.summary.typeFlips, 1);
  } finally {
    rmSync(ws, { recursive: true });
  }
});

test('expandAliases is idempotent on second run', async () => {
  const ws = tempWorkspace();
  try {
    const filePath = join(ws, 'user-data/memory/profile/people/jake-lee.md');
    writeFileSync(filePath, `---\ntype: topic\naliases: [Jake]\n---\n\n# Jake Lee\n\n`);
    await expandAliases({ workspaceDir: ws, stopList: new Set() });
    const result2 = await expandAliases({ workspaceDir: ws, stopList: new Set() });
    assert.equal(result2.summary.aliasesAdded, 0);
    assert.equal(result2.summary.typeFlips, 0);
  } finally {
    rmSync(ws, { recursive: true });
  }
});

test('expandAliases lists files without any aliases as missing-aliases (lint section)', async () => {
  const ws = tempWorkspace();
  try {
    const filePath = join(ws, 'user-data/memory/profile/people/no-aliases.md');
    writeFileSync(filePath, `---\ntype: topic\n---\n\n# Some Person\n\n`);
    const result = await expandAliases({ workspaceDir: ws, stopList: new Set() });
    assert.equal(result.summary.aliasesAdded, 0);
    assert.deepEqual(result.lint.missingAliases, ['profile/people/no-aliases.md']);
  } finally {
    rmSync(ws, { recursive: true });
  }
});

test('expandAliases handles quoted aliases array on read (real user-data format)', async () => {
  const ws = tempWorkspace();
  try {
    const filePath = join(ws, 'user-data/memory/profile/people/jake-lee.md');
    writeFileSync(filePath, `---\ntype: topic\naliases: ["Jake", "Joony", "brother"]\n---\n\n# Jake Lee\n\n`);
    const result = await expandAliases({ workspaceDir: ws, stopList: new Set() });
    // Existing aliases recognized: Jake, Joony, brother. New candidate: Jake Lee. Collision check sees clean.
    const after = readFileSync(filePath, 'utf-8');
    assert.match(after, /aliases: \["Jake", "Joony", "brother", "Jake Lee"\]/);
    assert.equal(result.summary.aliasesAdded, 1);
    assert.equal(result.summary.typeFlips, 1);
  } finally {
    rmSync(ws, { recursive: true });
  }
});

test('expandAliases registry detects collision across two files with quoted aliases', async () => {
  const ws = tempWorkspace();
  try {
    // File A claims "Bay Photo" first.
    writeFileSync(join(ws, 'user-data/memory/knowledge/service-providers/bay-photo.md'),
      `---\ntype: entity\naliases: ["Bay Photo", "Bay Photo Lab"]\n---\n# Bay Photo\n`);
    // File B's H1 would derive "Bay Photo" — must be rejected as collision.
    writeFileSync(join(ws, 'user-data/memory/knowledge/service-providers/another.md'),
      `---\ntype: topic\naliases: ["Other"]\n---\n# Bay Photo\n`);
    const result = await expandAliases({ workspaceDir: ws, stopList: new Set() });
    // bay-photo.md: candidate "Bay Photo" already exists, no new aliases.
    // another.md: candidate "Bay Photo" should be rejected as collision (claimed by bay-photo.md).
    const otherAfter = readFileSync(join(ws, 'user-data/memory/knowledge/service-providers/another.md'), 'utf-8');
    // Only check the aliases frontmatter field — the H1 itself legitimately contains "Bay Photo".
    assert.doesNotMatch(otherAfter, /aliases:.*Bay Photo/, 'another.md must not gain Bay Photo alias');
    // The collision should be in the rejections.
    const rejection = result.summary.rejections.find(r =>
      r.relPath === 'knowledge/service-providers/another.md' &&
      r.candidate === 'Bay Photo'
    );
    assert.ok(rejection, 'expected collision rejection for Bay Photo on another.md');
    assert.match(rejection.reason, /collision/);
  } finally {
    rmSync(ws, { recursive: true });
  }
});

test('expandAliases preserves comma-bearing aliases through round-trip', async () => {
  const ws = tempWorkspace();
  try {
    const filePath = join(ws, 'user-data/memory/profile/people/dr-yangdhar.md');
    writeFileSync(filePath, `---\ntype: topic\naliases: ["Dr. Yangdhar", "Nyima Yangdhar, MD"]\n---\n# Dr Yangdhar\n`);
    await expandAliases({ workspaceDir: ws, stopList: new Set() });
    const after = readFileSync(filePath, 'utf-8');
    // The comma-bearing alias must survive — not split into two.
    assert.match(after, /"Nyima Yangdhar, MD"/, 'comma-bearing alias must be quoted');
    // Subsequent read should recognize the original alias unchanged.
    const result2 = await expandAliases({ workspaceDir: ws, stopList: new Set() });
    assert.equal(result2.summary.aliasesAdded, 0, 'second run should be a no-op');
  } finally {
    rmSync(ws, { recursive: true });
  }
});

test('expandAliases gracefully skips files with block-style YAML aliases (treats as missing-aliases)', async () => {
  const ws = tempWorkspace();
  try {
    // Block-style aliases not currently parsed by alias-expander; file should fall through to lint.missingAliases without crashing.
    writeFileSync(join(ws, 'user-data/memory/profile/people/block-style.md'),
      `---\ntype: entity\naliases:\n  - Jake\n  - Joony\n---\n\n# Block Style\n`);
    const result = await expandAliases({ workspaceDir: ws, stopList: new Set() });
    // Falls through because regex doesn't match block-style; no crash.
    assert.deepEqual(result.lint.missingAliases, ['profile/people/block-style.md']);
    assert.equal(result.filesModified.length, 0);
  } finally {
    rmSync(ws, { recursive: true });
  }
});
