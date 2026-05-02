import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { up, id, description } from '../../migrations/0024-drop-platform-field.js';

function workspace() {
  const dir = mkdtempSync(join(tmpdir(), 'mig0024-'));
  mkdirSync(join(dir, 'user-data', 'runtime', 'config'), { recursive: true });
  return dir;
}

function cfgPath(ws) {
  return join(ws, 'user-data', 'runtime', 'config', 'robin.config.json');
}

function writeCfg(ws, obj) {
  writeFileSync(cfgPath(ws), JSON.stringify(obj, null, 2) + '\n', 'utf-8');
}

function readCfg(ws) {
  return JSON.parse(readFileSync(cfgPath(ws), 'utf-8'));
}

test('migration metadata', () => {
  assert.equal(id, '0024-drop-platform-field');
  assert.match(description, /platform/i);
});

test('removes platform field when present', async () => {
  const ws = workspace();
  writeCfg(ws, {
    user: { name: 'Kevin', timezone: 'America/Toronto' },
    platform: 'claude-code',
    assistant: { name: 'Robin' },
  });
  await up({ workspaceDir: ws });
  const cfg = readCfg(ws);
  assert.equal(cfg.platform, undefined);
  assert.equal(cfg.user.name, 'Kevin');
  assert.equal(cfg.user.timezone, 'America/Toronto');
  assert.equal(cfg.assistant.name, 'Robin');
});

test('idempotent: no-op when platform field already absent', async () => {
  const ws = workspace();
  writeCfg(ws, {
    user: { name: 'Kevin' },
    assistant: { name: 'Robin' },
  });
  const before = readFileSync(cfgPath(ws), 'utf-8');
  await up({ workspaceDir: ws });
  const after = readFileSync(cfgPath(ws), 'utf-8');
  assert.equal(after, before);
});

test('idempotent: running twice yields same result', async () => {
  const ws = workspace();
  writeCfg(ws, {
    user: { name: 'Kevin' },
    platform: 'cursor',
    assistant: { name: 'Robin' },
  });
  await up({ workspaceDir: ws });
  const after1 = readFileSync(cfgPath(ws), 'utf-8');
  await up({ workspaceDir: ws });
  const after2 = readFileSync(cfgPath(ws), 'utf-8');
  assert.equal(after1, after2);
  assert.equal(readCfg(ws).platform, undefined);
});

test('no-op when config file is missing', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'mig0024-missing-'));
  // No config file created.
  await up({ workspaceDir: ws });
  assert.equal(existsSync(cfgPath(ws)), false);
});

test('preserves sibling fields not on the rename list', async () => {
  const ws = workspace();
  writeCfg(ws, {
    user: { name: 'Kevin', email: 'k@example.com' },
    platform: 'gemini-cli',
    assistant: { name: 'Robin' },
    customField: { foo: 'bar' },
  });
  await up({ workspaceDir: ws });
  const cfg = readCfg(ws);
  assert.equal(cfg.platform, undefined);
  assert.deepEqual(cfg.customField, { foo: 'bar' });
  assert.equal(cfg.user.email, 'k@example.com');
});
