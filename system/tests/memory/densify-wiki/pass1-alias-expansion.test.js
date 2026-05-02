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
    assert.match(after, /aliases: \[Jake, Jake Lee\]/);
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
