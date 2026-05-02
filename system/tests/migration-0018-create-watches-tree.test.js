import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { up, id, description } from '../migrations/0018-create-watches-tree.js';

function workspace() {
  const dir = mkdtempSync(join(tmpdir(), 'mig0018-'));
  // Minimal user-data structure (migration doesn't require any pre-existing dirs)
  return dir;
}

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

test('migration metadata is correct', () => {
  assert.equal(id, '0018-create-watches-tree');
  assert.match(description, /watches/i);
});

// ---------------------------------------------------------------------------
// Happy path: fresh install
// ---------------------------------------------------------------------------

test('creates watches memory dir and scaffold files when missing', async () => {
  const ws = workspace();
  const memDir = join(ws, 'user-data/memory/watches');
  const stateDir = join(ws, 'user-data/state/watches');

  assert.ok(!existsSync(memDir), 'precondition: memory/watches must not exist');
  assert.ok(!existsSync(stateDir), 'precondition: state/watches must not exist');

  await up({ workspaceDir: ws });

  assert.ok(existsSync(memDir), 'user-data/memory/watches/ should be created');
  assert.ok(existsSync(stateDir), 'user-data/state/watches/ should be created');

  const indexMd = join(memDir, 'INDEX.md');
  assert.ok(existsSync(indexMd), 'INDEX.md should be created');
  const indexContent = readFileSync(indexMd, 'utf8');
  assert.match(indexContent, /watches/i, 'INDEX.md should mention watches');
  assert.match(indexContent, /^---/m, 'INDEX.md should have frontmatter');

  const logMd = join(memDir, 'log.md');
  assert.ok(existsSync(logMd), 'log.md should be created');
  const logContent = readFileSync(logMd, 'utf8');
  assert.match(logContent, /Watch hits log/i, 'log.md should have correct heading');
});

// ---------------------------------------------------------------------------
// Idempotent re-run
// ---------------------------------------------------------------------------

test('idempotent: re-running on already-migrated state is a no-op', async () => {
  const ws = workspace();

  // First run
  await up({ workspaceDir: ws });

  const indexPath = join(ws, 'user-data/memory/watches/INDEX.md');
  const logPath = join(ws, 'user-data/memory/watches/log.md');
  const afterFirst = {
    index: readFileSync(indexPath, 'utf8'),
    log: readFileSync(logPath, 'utf8'),
  };

  // Second run
  await up({ workspaceDir: ws });

  assert.equal(readFileSync(indexPath, 'utf8'), afterFirst.index, 'INDEX.md must be unchanged');
  assert.equal(readFileSync(logPath, 'utf8'), afterFirst.log, 'log.md must be unchanged');
});

// ---------------------------------------------------------------------------
// Preserve user content
// ---------------------------------------------------------------------------

test('does not overwrite existing INDEX.md or log.md', async () => {
  const ws = workspace();
  const memDir = join(ws, 'user-data/memory/watches');
  mkdirSync(memDir, { recursive: true });

  const customIndex = '---\ndescription: custom\n---\n# Custom INDEX\n';
  const customLog = '# My custom log\n\nSome entries.\n';
  writeFileSync(join(memDir, 'INDEX.md'), customIndex);
  writeFileSync(join(memDir, 'log.md'), customLog);

  await up({ workspaceDir: ws });

  assert.equal(readFileSync(join(memDir, 'INDEX.md'), 'utf8'), customIndex, 'INDEX.md must not be overwritten');
  assert.equal(readFileSync(join(memDir, 'log.md'), 'utf8'), customLog, 'log.md must not be overwritten');
});

// ---------------------------------------------------------------------------
// Partial state — state/watches exists but memory/watches doesn't
// ---------------------------------------------------------------------------

test('creates memory/watches even if state/watches already exists', async () => {
  const ws = workspace();
  const stateDir = join(ws, 'user-data/state/watches');
  mkdirSync(stateDir, { recursive: true });

  await up({ workspaceDir: ws });

  const memDir = join(ws, 'user-data/memory/watches');
  assert.ok(existsSync(memDir), 'memory/watches should be created');
  assert.ok(existsSync(join(memDir, 'INDEX.md')), 'INDEX.md should be created');
});

// ---------------------------------------------------------------------------
// Partial state — memory/watches exists but state/watches doesn't
// ---------------------------------------------------------------------------

test('creates state/watches even if memory/watches already exists', async () => {
  const ws = workspace();
  const memDir = join(ws, 'user-data/memory/watches');
  mkdirSync(memDir, { recursive: true });
  writeFileSync(join(memDir, 'INDEX.md'), '# INDEX\n');
  writeFileSync(join(memDir, 'log.md'), '# Log\n');

  await up({ workspaceDir: ws });

  const stateDir = join(ws, 'user-data/state/watches');
  assert.ok(existsSync(stateDir), 'state/watches should be created');
});
