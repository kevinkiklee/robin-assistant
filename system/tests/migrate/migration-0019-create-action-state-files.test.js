import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  cpSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { up, id, description } from '../../migrations/0019-create-action-state-files.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..', '..');

function workspace() {
  const dir = mkdtempSync(join(tmpdir(), 'mig0019-'));
  // Mirror scaffold + system migrations into the temp workspace so the
  // migration finds them via __dirname-relative path.
  cpSync(join(REPO_ROOT, 'system'), join(dir, 'system'), { recursive: true });
  mkdirSync(join(dir, 'user-data/memory/self-improvement'), { recursive: true });
  mkdirSync(join(dir, 'user-data/runtime/state/turn'), { recursive: true });
  return dir;
}

test('migration metadata', () => {
  assert.equal(id, '0019-create-action-state-files');
  assert.match(description, /policies|action-trust|pending-asks/i);
});

test('creates all three files when absent', async () => {
  const ws = workspace();
  await up({ workspaceDir: ws });

  const policies = join(ws, 'user-data/runtime/config/policies.md');
  const trust = join(ws, 'user-data/memory/self-improvement/action-trust.md');
  const pending = join(ws, 'user-data/runtime/state/turn/pending-asks.md');

  assert.ok(existsSync(policies), 'policies.md should exist');
  assert.ok(existsSync(trust), 'action-trust.md should exist');
  assert.ok(existsSync(pending), 'pending-asks.md should exist');

  assert.match(readFileSync(policies, 'utf8'), /## AUTO/);
  assert.match(readFileSync(trust, 'utf8'), /## Open/);
  assert.match(readFileSync(pending, 'utf8'), /Pending Asks/);
});

test('idempotent: skips files that already exist with content', async () => {
  const ws = workspace();
  const policies = join(ws, 'user-data/runtime/config/policies.md');
  mkdirSync(dirname(policies), { recursive: true });
  const userContent = `---
description: My custom policies
type: reference
---

## AUTO
- my-custom-class
`;
  writeFileSync(policies, userContent);

  await up({ workspaceDir: ws });

  assert.equal(readFileSync(policies, 'utf8'), userContent, 'must not overwrite user policies');
});

test('idempotent: re-running on migrated state is a no-op', async () => {
  const ws = workspace();
  await up({ workspaceDir: ws });
  const before = readFileSync(join(ws, 'user-data/runtime/config/policies.md'), 'utf8');
  await up({ workspaceDir: ws });
  const after = readFileSync(join(ws, 'user-data/runtime/config/policies.md'), 'utf8');
  assert.equal(after, before);
});

test('creates parent directories if missing', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'mig0019-bare-'));
  cpSync(join(REPO_ROOT, 'system'), join(ws, 'system'), { recursive: true });
  // Note: NOT pre-creating user-data subdirs.

  await up({ workspaceDir: ws });

  assert.ok(existsSync(join(ws, 'user-data/memory/self-improvement/action-trust.md')));
  assert.ok(existsSync(join(ws, 'user-data/runtime/state/turn/pending-asks.md')));
});
