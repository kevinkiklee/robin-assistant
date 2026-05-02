import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateMemoryIndex, writeMemoryIndex, checkMemoryIndex } from '../../scripts/memory/regenerate-index.js';

function makeTree() {
  const root = mkdtempSync(join(tmpdir(), 'robin-mem-'));
  const mem = join(root, 'memory');
  mkdirSync(mem, { recursive: true });
  mkdirSync(join(mem, 'profile'));
  mkdirSync(join(mem, 'knowledge'));
  writeFileSync(join(mem, 'INDEX.md'), '# old index\n');
  writeFileSync(join(mem, 'inbox.md'), '---\ndescription: Capture buffer\n---\n# Inbox\n');
  writeFileSync(join(mem, 'profile/identity.md'), '---\ndescription: Identity facts\n---\n# Identity\n');
  writeFileSync(join(mem, 'knowledge/medical.md'), '---\ndescription: Medical info\n---\n# Medical\n');
  return { root, mem };
}

test('generateMemoryIndex produces a sorted table from frontmatter', () => {
  const { root, mem } = makeTree();
  const out = generateMemoryIndex(mem);
  assert.match(out, /# Memory Index/);
  assert.match(out, /\| inbox\.md \| Capture buffer \|/);
  assert.match(out, /\| knowledge\/medical\.md \| Medical info \|/);
  assert.match(out, /\| profile\/identity\.md \| Identity facts \|/);
  const idxInbox = out.indexOf('inbox.md');
  const idxKnowledge = out.indexOf('knowledge/medical.md');
  const idxProfile = out.indexOf('profile/identity.md');
  assert.ok(idxInbox < idxKnowledge && idxKnowledge < idxProfile);
  rmSync(root, { recursive: true, force: true });
});

test('generateMemoryIndex throws when a file lacks description frontmatter', () => {
  const { root, mem } = makeTree();
  writeFileSync(join(mem, 'profile/personality.md'), '# No frontmatter\n');
  assert.throws(() => generateMemoryIndex(mem), /personality\.md/);
  rmSync(root, { recursive: true, force: true });
});

test('writeMemoryIndex writes INDEX.md', () => {
  const { root, mem } = makeTree();
  writeMemoryIndex(mem);
  const out = readFileSync(join(mem, 'INDEX.md'), 'utf-8');
  assert.match(out, /# Memory Index/);
  rmSync(root, { recursive: true, force: true });
});

test('generateMemoryIndex skips INDEX.md and .gitkeep', () => {
  const { root, mem } = makeTree();
  writeFileSync(join(mem, '.gitkeep'), '');
  const out = generateMemoryIndex(mem);
  assert.ok(!out.includes('.gitkeep'));
  assert.ok(!out.includes('| INDEX.md |'));
  rmSync(root, { recursive: true, force: true });
});

test('checkMemoryIndex returns true when INDEX is up to date', () => {
  const { root, mem } = makeTree();
  writeMemoryIndex(mem);
  assert.equal(checkMemoryIndex(mem), true);
  rmSync(root, { recursive: true, force: true });
});

test('checkMemoryIndex returns false when INDEX differs', () => {
  const { root, mem } = makeTree();
  writeFileSync(join(mem, 'INDEX.md'), '# stale\n');
  assert.equal(checkMemoryIndex(mem), false);
  rmSync(root, { recursive: true, force: true });
});

test('generateMemoryIndex emits default routing block when no existing INDEX.md', () => {
  const { root, mem } = makeTree();
  const out = generateMemoryIndex(mem);
  assert.match(out, /<!-- BEGIN where-to-look-first -->/);
  assert.match(out, /<!-- END where-to-look-first -->/);
  assert.match(out, /## Where to look first/);
  // Default rows present
  assert.match(out, /A specific person/);
  assert.match(out, /knowledge\/finance\/transactions\.md/);
  rmSync(root, { recursive: true, force: true });
});

test('generateMemoryIndex preserves user-edited routing block from existing INDEX.md', () => {
  const { root, mem } = makeTree();
  // Seed an INDEX.md with a customized routing block
  const existing = `# Memory Index

Robin's memory tree. The "Where to look first" block below is hand-curated; the path table is auto-regenerated. Read both before opening a sub-tree.

<!-- BEGIN where-to-look-first -->
## Where to look first

| If the question is about… | Start with |
|---|---|
| MY CUSTOM ROW | custom/path.md |
<!-- END where-to-look-first -->

| path | what's in it |
|------|--------------|
`;
  writeFileSync(join(mem, 'INDEX.md'), existing);
  const out = generateMemoryIndex(mem);
  assert.match(out, /MY CUSTOM ROW/, 'custom row preserved');
  assert.doesNotMatch(out, /A specific person/, 'default rows not re-injected when user has edits');
  rmSync(root, { recursive: true, force: true });
});

test('checkMemoryIndex ignores changes inside the routing block', () => {
  const { root, mem } = makeTree();
  writeMemoryIndex(mem); // baseline
  const existing = readFileSync(join(mem, 'INDEX.md'), 'utf8');
  // Modify only inside the routing block
  const edited = existing.replace(
    /<!-- BEGIN where-to-look-first -->[\s\S]*?<!-- END where-to-look-first -->/,
    `<!-- BEGIN where-to-look-first -->
## Where to look first
| edited row | foo.md |
<!-- END where-to-look-first -->`,
  );
  writeFileSync(join(mem, 'INDEX.md'), edited);
  assert.equal(checkMemoryIndex(mem), true, 'routing-block edits do not fail consistency');
  rmSync(root, { recursive: true, force: true });
});

test('checkMemoryIndex still fails on auto-table drift', () => {
  const { root, mem } = makeTree();
  writeMemoryIndex(mem);
  // Tamper with the auto-table region
  const existing = readFileSync(join(mem, 'INDEX.md'), 'utf8');
  writeFileSync(
    join(mem, 'INDEX.md'),
    existing.replace(/\| profile\/identity\.md \| .+? \|/, '| profile/identity.md | tampered description |'),
  );
  assert.equal(checkMemoryIndex(mem), false);
  rmSync(root, { recursive: true, force: true });
});
