import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { up, down, id, description } from '../../migrations/0022-rename-ops-to-runtime.js';

function workspace() {
  const dir = mkdtempSync(join(tmpdir(), 'mig0022-'));
  mkdirSync(join(dir, 'user-data'), { recursive: true });
  return dir;
}

test('migration metadata', () => {
  assert.equal(id, '0022-rename-ops-to-runtime');
  assert.match(description, /ops|runtime/);
});

test('up renames user-data/ops/ → user-data/runtime/', async () => {
  const ws = workspace();
  mkdirSync(join(ws, 'user-data/ops/config'), { recursive: true });
  writeFileSync(join(ws, 'user-data/ops/config/policies.md'), '# policies');

  await up({ workspaceDir: ws });

  assert.ok(!existsSync(join(ws, 'user-data/ops')), 'ops/ should be gone');
  assert.ok(existsSync(join(ws, 'user-data/runtime/config/policies.md')), 'runtime/ should exist');
});

test('up is idempotent — no-op when ops/ does not exist', async () => {
  const ws = workspace();
  mkdirSync(join(ws, 'user-data/runtime/config'), { recursive: true });
  writeFileSync(join(ws, 'user-data/runtime/config/policies.md'), '# already');

  await up({ workspaceDir: ws });

  assert.ok(!existsSync(join(ws, 'user-data/ops')));
  assert.ok(existsSync(join(ws, 'user-data/runtime/config/policies.md')));
});

test('up clears empty runtime/ tree (preflight scaffold-sync race)', async () => {
  const ws = workspace();
  // Live ops/ has real data:
  mkdirSync(join(ws, 'user-data/ops/config'), { recursive: true });
  writeFileSync(join(ws, 'user-data/ops/config/policies.md'), '# real');
  // runtime/ has only empty dirs (as preflight would create from scaffold scan):
  mkdirSync(join(ws, 'user-data/runtime/config'), { recursive: true });
  mkdirSync(join(ws, 'user-data/runtime/state/turn'), { recursive: true });

  await up({ workspaceDir: ws });

  assert.ok(!existsSync(join(ws, 'user-data/ops')), 'ops/ should be gone');
  assert.equal(
    readFileSync(join(ws, 'user-data/runtime/config/policies.md'), 'utf8'),
    '# real',
    'real ops/ data should now be at runtime/',
  );
});

test('up refuses when runtime/ has any actual file', async () => {
  const ws = workspace();
  mkdirSync(join(ws, 'user-data/ops/config'), { recursive: true });
  writeFileSync(join(ws, 'user-data/ops/config/policies.md'), '# ops');
  mkdirSync(join(ws, 'user-data/runtime/config'), { recursive: true });
  writeFileSync(join(ws, 'user-data/runtime/config/policies.md'), '# rt');

  await assert.rejects(() => up({ workspaceDir: ws }), /both .* exist with files/);
});

test('down clears empty ops/ tree symmetrically', async () => {
  const ws = workspace();
  mkdirSync(join(ws, 'user-data/runtime/config'), { recursive: true });
  writeFileSync(join(ws, 'user-data/runtime/config/policies.md'), '# real');
  mkdirSync(join(ws, 'user-data/ops/config'), { recursive: true });

  await down({ workspaceDir: ws });

  assert.ok(!existsSync(join(ws, 'user-data/runtime')), 'runtime/ should be gone');
  assert.equal(
    readFileSync(join(ws, 'user-data/ops/config/policies.md'), 'utf8'),
    '# real',
  );
});

test('down reverses the rename', async () => {
  const ws = workspace();
  mkdirSync(join(ws, 'user-data/runtime/config'), { recursive: true });
  writeFileSync(join(ws, 'user-data/runtime/config/policies.md'), '# r');

  await down({ workspaceDir: ws });

  assert.ok(!existsSync(join(ws, 'user-data/runtime')));
  assert.ok(existsSync(join(ws, 'user-data/ops/config/policies.md')));
});

test('down is idempotent — no-op when runtime/ does not exist', async () => {
  const ws = workspace();
  mkdirSync(join(ws, 'user-data/ops/config'), { recursive: true });

  await down({ workspaceDir: ws });

  assert.ok(existsSync(join(ws, 'user-data/ops/config')));
});
