import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { up, id, description } from '../../migrations/0026-add-optimize-config.js';

function workspace() {
  const dir = mkdtempSync(join(tmpdir(), 'mig0026-'));
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
  assert.equal(id, '0026-add-optimize-config');
  assert.match(description, /optimize/i);
});

test('adds optimize block when missing', async () => {
  const ws = workspace();
  writeCfg(ws, {
    user: { name: 'Kevin' },
    assistant: { name: 'Robin' },
  });
  await up({ workspaceDir: ws });
  const cfg = readCfg(ws);
  assert.ok(cfg.optimize, 'optimize block created');
  assert.equal(cfg.optimize.subagent_dispatch, 'off');
});

test('preserves existing optimize values', async () => {
  const ws = workspace();
  writeCfg(ws, {
    user: { name: 'Kevin' },
    optimize: { subagent_dispatch: 'all-side-quest' },
  });
  await up({ workspaceDir: ws });
  const cfg = readCfg(ws);
  assert.equal(cfg.optimize.subagent_dispatch, 'all-side-quest');
});

test('backfills missing keys without overwriting existing ones', async () => {
  const ws = workspace();
  writeCfg(ws, {
    user: { name: 'Kevin' },
    optimize: {
      $comment: 'custom user comment',
      // subagent_dispatch missing — should be backfilled
    },
  });
  await up({ workspaceDir: ws });
  const cfg = readCfg(ws);
  assert.equal(cfg.optimize.$comment, 'custom user comment', 'preserves existing custom comment');
  assert.equal(cfg.optimize.subagent_dispatch, 'off', 'backfills missing default');
});

test('idempotent: running twice yields same result when complete', async () => {
  const ws = workspace();
  writeCfg(ws, {
    user: { name: 'Kevin' },
  });
  await up({ workspaceDir: ws });
  const after1 = readFileSync(cfgPath(ws), 'utf-8');
  await up({ workspaceDir: ws });
  const after2 = readFileSync(cfgPath(ws), 'utf-8');
  assert.equal(after2, after1);
});

test('no-op when config file does not exist', async () => {
  const ws = workspace();
  // Don't create config file
  await up({ workspaceDir: ws });
  // No throw means pass.
});
