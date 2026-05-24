import assert from 'node:assert/strict';
import { test } from 'node:test';
import { denyUnsafe, handler } from './a-self-improvement.ts';
import { REGISTRY } from './types.ts';

const ctx = { repoRoot: '/repo', worktree: '/repo/.worktrees/x' };

test('A: registers itself under id "A"', () => {
  assert.equal(REGISTRY.A, handler);
});

test('A: build() config — trigger, permissionMode, allowedTools', () => {
  const out = handler.build('refactor the ledger', ctx);
  assert.equal(handler.trigger, 'on-demand');
  assert.equal(out.permissionMode, 'acceptEdits');
  assert.deepEqual(out.allowedTools, ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash']);
  assert.equal(out.maxTurns, 30);
  assert.equal(out.timeoutMs, 1_800_000);
  assert.equal(out.maxBudgetUsd, 5);
  assert.equal(out.loadProjectSettings, true);
  assert.equal(out.enableFileCheckpointing, true);
  assert.equal(typeof out.canUseTool, 'function');
});

test('A: cwd prefers the worktree, falls back to repoRoot', () => {
  assert.equal(handler.build('g', ctx).cwd, '/repo/.worktrees/x');
  assert.equal(handler.build('g', { repoRoot: '/repo' }).cwd, '/repo');
});

const cwd = '/repo/.worktrees/x';

test('denyUnsafe: denies destructive / push / commit Bash', () => {
  assert.equal(denyUnsafe('Bash', { command: 'git push origin main' }, cwd).behavior, 'deny');
  assert.equal(denyUnsafe('Bash', { command: 'git commit -m wip' }, cwd).behavior, 'deny');
  assert.equal(denyUnsafe('Bash', { command: 'rm -rf node_modules' }, cwd).behavior, 'deny');
  assert.equal(denyUnsafe('Bash', { command: 'pnpm build && git push' }, cwd).behavior, 'deny');
});

test('denyUnsafe: allows safe Bash (test/lint)', () => {
  assert.equal(denyUnsafe('Bash', { command: 'pnpm test' }, cwd).behavior, 'allow');
  assert.equal(denyUnsafe('Bash', { command: 'pnpm lint' }, cwd).behavior, 'allow');
});

test('denyUnsafe: denies Write/Edit escaping cwd', () => {
  assert.equal(denyUnsafe('Write', { file_path: '/etc/passwd' }, cwd).behavior, 'deny');
  assert.equal(
    denyUnsafe('Edit', { file_path: '/repo/.worktrees/x/../../secret.ts' }, cwd).behavior,
    'deny',
  );
  // Relative path traversal also escapes when resolved against cwd.
  assert.equal(denyUnsafe('Write', { file_path: '../../outside.ts' }, cwd).behavior, 'deny');
});

test('denyUnsafe: allows in-cwd Edit', () => {
  assert.equal(
    denyUnsafe('Edit', { file_path: '/repo/.worktrees/x/system/agent/sdk.ts' }, cwd).behavior,
    'allow',
  );
  // Relative in-cwd path resolves inside cwd.
  assert.equal(denyUnsafe('Edit', { file_path: 'system/agent/sdk.ts' }, cwd).behavior, 'allow');
});

test('denyUnsafe: passes through unrelated tools', () => {
  assert.equal(denyUnsafe('Read', { file_path: '/anywhere' }, cwd).behavior, 'allow');
});
