import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OUTCOME_ENVELOPE_FORMAT } from '../outcome.ts';
import { handler } from './j-integration-author.ts';
import { REGISTRY } from './types.ts';

const ctx = { repoRoot: '/repo', worktree: '/repo/.worktrees/x' };

test('J: registers itself under id "J"', () => {
  assert.equal(REGISTRY.J, handler);
});

test('J: build() config — trigger, permissionMode, allowedTools', () => {
  const out = handler.build('integrate with notion', ctx);
  assert.equal(handler.trigger, 'on-demand');
  assert.equal(out.permissionMode, 'acceptEdits');
  assert.deepEqual(out.allowedTools, ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash']);
  assert.equal(out.maxTurns, 32);
  assert.equal(out.timeoutMs, 1_800_000);
  assert.equal(out.maxBudgetUsd, 5);
  assert.equal(out.loadProjectSettings, true);
  assert.equal(out.enableFileCheckpointing, true);
  assert.equal(typeof out.canUseTool, 'function');
  assert.equal(out.outputFormat, OUTCOME_ENVELOPE_FORMAT);
});

test('J: cwd prefers the worktree, falls back to repoRoot', () => {
  assert.equal(handler.build('g', ctx).cwd, '/repo/.worktrees/x');
  assert.equal(handler.build('g', { repoRoot: '/repo' }).cwd, '/repo');
});

test('J: canUseTool delegates to denyUnsafe — denies git push', () => {
  const out = handler.build('g', ctx);
  const decision = out.canUseTool('Bash', { command: 'git push origin main' });
  assert.equal(decision.behavior, 'deny');
});
