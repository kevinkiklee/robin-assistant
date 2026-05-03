import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { up, id, description } from '../../migrations/0025-rename-agentsmd-to-claudemd.js';

function workspace() {
  const dir = mkdtempSync(join(tmpdir(), 'mig0025-'));
  mkdirSync(join(dir, 'user-data', 'runtime', 'security'), { recursive: true });
  return dir;
}

function manifestPath(ws) {
  return join(ws, 'user-data', 'runtime', 'security', 'manifest.json');
}

function writeManifest(ws, obj) {
  writeFileSync(manifestPath(ws), JSON.stringify(obj, null, 2) + '\n', 'utf-8');
}

function readManifest(ws) {
  return JSON.parse(readFileSync(manifestPath(ws), 'utf-8'));
}

test('migration metadata', () => {
  assert.equal(id, '0025-rename-agentsmd-to-claudemd');
  assert.match(description, /agentsmd.*claudemd/i);
});

test('renames agentsmd → claudemd preserving values', async () => {
  const ws = workspace();
  writeManifest(ws, {
    version: 2,
    hooks: {},
    agentsmd: { hardRulesHash: 'abc123', lastSnapshot: '2026-04-30' },
  });
  await up({ workspaceDir: ws });
  const m = readManifest(ws);
  assert.equal(m.agentsmd, undefined);
  assert.deepEqual(m.claudemd, { hardRulesHash: 'abc123', lastSnapshot: '2026-04-30' });
});

test('no-op when only claudemd exists', async () => {
  const ws = workspace();
  writeManifest(ws, {
    version: 2,
    hooks: {},
    claudemd: { hardRulesHash: 'def456', lastSnapshot: '2026-05-01' },
  });
  const before = readFileSync(manifestPath(ws), 'utf-8');
  await up({ workspaceDir: ws });
  const after = readFileSync(manifestPath(ws), 'utf-8');
  assert.equal(after, before);
});

test('prefers claudemd when both keys present and drops agentsmd', async () => {
  const ws = workspace();
  writeManifest(ws, {
    version: 2,
    hooks: {},
    agentsmd: { hardRulesHash: 'old', lastSnapshot: '2026-01-01' },
    claudemd: { hardRulesHash: 'new', lastSnapshot: '2026-05-01' },
  });
  await up({ workspaceDir: ws });
  const m = readManifest(ws);
  assert.equal(m.agentsmd, undefined);
  assert.deepEqual(m.claudemd, { hardRulesHash: 'new', lastSnapshot: '2026-05-01' });
});

test('idempotent: running twice yields same result', async () => {
  const ws = workspace();
  writeManifest(ws, {
    version: 2,
    hooks: {},
    agentsmd: { hardRulesHash: 'abc', lastSnapshot: '2026-04-30' },
  });
  await up({ workspaceDir: ws });
  const after1 = readFileSync(manifestPath(ws), 'utf-8');
  await up({ workspaceDir: ws });
  const after2 = readFileSync(manifestPath(ws), 'utf-8');
  assert.equal(after1, after2);
});

test('no-op when manifest file is missing', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'mig0025-missing-'));
  await up({ workspaceDir: ws });
  assert.equal(existsSync(manifestPath(ws)), false);
});

test('preserves sibling fields', async () => {
  const ws = workspace();
  writeManifest(ws, {
    version: 2,
    hooks: { Stop: [{ command: 'x' }] },
    mcpServers: { expected: ['m1'], writeCapable: [] },
    agentsmd: { hardRulesHash: 'h', lastSnapshot: '2026-04-30' },
    userDataJobs: { knownFiles: ['custom.md'] },
  });
  await up({ workspaceDir: ws });
  const m = readManifest(ws);
  assert.equal(m.version, 2);
  assert.deepEqual(m.hooks.Stop, [{ command: 'x' }]);
  assert.deepEqual(m.mcpServers.expected, ['m1']);
  assert.deepEqual(m.userDataJobs.knownFiles, ['custom.md']);
});
