import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { up, id, description } from '../../migrations/0017-add-decay-defaults.js';
import { parseFrontmatter } from '../../scripts/memory/lib/memory-index.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function workspace() {
  const dir = mkdtempSync(join(tmpdir(), 'mig0017-'));
  mkdirSync(join(dir, 'user-data', 'memory', 'profile'), { recursive: true });
  mkdirSync(join(dir, 'user-data', 'memory', 'knowledge', 'movies'), { recursive: true });
  mkdirSync(join(dir, 'user-data', 'memory', 'self-improvement'), { recursive: true });
  mkdirSync(join(dir, 'user-data', 'memory', 'sources'), { recursive: true });
  return dir;
}

function write(ws, relPath, content) {
  const full = join(ws, 'user-data', 'memory', relPath);
  writeFileSync(full, content, 'utf-8');
  return full;
}

function fm(ws, relPath) {
  const full = join(ws, 'user-data', 'memory', relPath);
  return parseFrontmatter(readFileSync(full, 'utf-8')).frontmatter;
}

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

test('migration metadata', () => {
  assert.equal(id, '0017-add-decay-defaults');
  assert.match(description, /decay/i);
});

// ---------------------------------------------------------------------------
// Sub-tree defaults
// ---------------------------------------------------------------------------

test('adds decay: slow to profile/* files', async () => {
  const ws = workspace();
  write(ws, 'profile/identity.md', `---\ndescription: identity\ntype: topic\n---\n# X\n`);
  await up({ workspaceDir: ws });
  assert.equal(fm(ws, 'profile/identity.md').decay, 'slow');
});

test('adds decay: medium to knowledge/* files', async () => {
  const ws = workspace();
  write(ws, 'knowledge/movies/ratings.md', `---\ndescription: ratings\ntype: reference\n---\n# X\n`);
  await up({ workspaceDir: ws });
  assert.equal(fm(ws, 'knowledge/movies/ratings.md').decay, 'medium');
});

test('adds decay: medium to self-improvement/* files', async () => {
  const ws = workspace();
  write(ws, 'self-improvement/calibration.md', `---\ndescription: calibration\ntype: topic\n---\n# X\n`);
  await up({ workspaceDir: ws });
  assert.equal(fm(ws, 'self-improvement/calibration.md').decay, 'medium');
});

test('adds decay: immortal to inbox.md', async () => {
  const ws = workspace();
  write(ws, 'inbox.md', `---\ndescription: inbox\ntype: topic\n---\n# Inbox\n`);
  await up({ workspaceDir: ws });
  assert.equal(fm(ws, 'inbox.md').decay, 'immortal');
});

test('adds decay: immortal to decisions.md', async () => {
  const ws = workspace();
  write(ws, 'decisions.md', `---\ndescription: decisions\ntype: topic\n---\n# Decisions\n`);
  await up({ workspaceDir: ws });
  assert.equal(fm(ws, 'decisions.md').decay, 'immortal');
});

test('adds decay: immortal to journal.md', async () => {
  const ws = workspace();
  write(ws, 'journal.md', `---\ndescription: journal\ntype: topic\n---\n# Journal\n`);
  await up({ workspaceDir: ws });
  assert.equal(fm(ws, 'journal.md').decay, 'immortal');
});

// ---------------------------------------------------------------------------
// Idempotent: existing decay value is preserved
// ---------------------------------------------------------------------------

test('preserves existing decay value (idempotent)', async () => {
  const ws = workspace();
  write(
    ws,
    'profile/goals.md',
    `---\ndescription: goals\ntype: topic\ndecay: fast\n---\n# Goals\n`,
  );
  await up({ workspaceDir: ws });
  assert.equal(fm(ws, 'profile/goals.md').decay, 'fast', 'user-set decay must not be overwritten');
});

// ---------------------------------------------------------------------------
// Re-run is a no-op
// ---------------------------------------------------------------------------

test('re-running is a no-op', async () => {
  const ws = workspace();
  write(ws, 'profile/interests.md', `---\ndescription: interests\ntype: topic\n---\n# X\n`);
  await up({ workspaceDir: ws });
  const afterFirst = fm(ws, 'profile/interests.md').decay;
  await up({ workspaceDir: ws });
  const afterSecond = fm(ws, 'profile/interests.md').decay;
  assert.equal(afterSecond, afterFirst, 'second run must not change decay');
});

// ---------------------------------------------------------------------------
// Files with no frontmatter — skip without crashing
// ---------------------------------------------------------------------------

test('skips file with no frontmatter block', async () => {
  const ws = workspace();
  const content = '# Just markdown\n\nNo frontmatter.\n';
  write(ws, 'profile/orphan.md', content);
  await up({ workspaceDir: ws });
  const full = join(ws, 'user-data', 'memory', 'profile', 'orphan.md');
  assert.equal(readFileSync(full, 'utf-8'), content, 'content must be unchanged');
});

// ---------------------------------------------------------------------------
// Other frontmatter fields are preserved
// ---------------------------------------------------------------------------

test('preserves other frontmatter fields when stamping decay', async () => {
  const ws = workspace();
  write(
    ws,
    'profile/personality.md',
    `---\ndescription: personality\ntype: topic\nlast_verified: 2025-01-01\n---\n# Personality\n`,
  );
  await up({ workspaceDir: ws });
  const f = fm(ws, 'profile/personality.md');
  assert.equal(f.description, 'personality', 'description preserved');
  assert.equal(f.type, 'topic', 'type preserved');
  assert.equal(f.last_verified, '2025-01-01', 'last_verified preserved');
  assert.equal(f.decay, 'slow', 'decay added');
});
