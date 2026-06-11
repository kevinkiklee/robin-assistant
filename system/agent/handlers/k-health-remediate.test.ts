import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handler } from './k-health-remediate.ts';
import { OUTCOME_ENVELOPE_FORMAT } from '../outcome.ts';
import { REGISTRY } from './types.ts';

const ctx = { repoRoot: '/repo', worktree: '/repo/.worktrees/x' };

test('K: registers itself under id "K"', () => {
  assert.equal(REGISTRY.K, handler);
});

test('K: build() config — trigger, permissionMode, allowedTools', () => {
  const out = handler.build('diagnose the failing calendar sync', ctx);
  assert.equal(handler.trigger, 'autonomous');
  assert.equal(out.permissionMode, 'acceptEdits');
  assert.deepEqual(out.allowedTools, [
    'Read',
    'Glob',
    'Grep',
    'Edit',
    'Bash',
    'mcp__robin__health',
    'mcp__robin__metrics',
  ]);
  assert.equal(out.maxTurns, 27);
  assert.equal(out.timeoutMs, 1_800_000);
  assert.equal(out.maxBudgetUsd, 4);
  assert.equal(out.loadProjectSettings, true);
  assert.equal(out.enableFileCheckpointing, true);
  assert.equal(typeof out.canUseTool, 'function');
  assert.equal(out.outputFormat, OUTCOME_ENVELOPE_FORMAT);
});

test('K: cwd prefers the worktree, falls back to repoRoot', () => {
  assert.equal(handler.build('g', ctx).cwd, '/repo/.worktrees/x');
  assert.equal(handler.build('g', { repoRoot: '/repo' }).cwd, '/repo');
});

test('K: canUseTool delegates to denyUnsafe — denies git push', () => {
  const out = handler.build('g', ctx);
  const decision = out.canUseTool('Bash', { command: 'git push origin main' });
  assert.equal(decision.behavior, 'deny');
});
