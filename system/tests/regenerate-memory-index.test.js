import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateMemoryIndex, writeMemoryIndex } from '../scripts/regenerate-memory-index.js';

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
