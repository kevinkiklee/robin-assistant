import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handler } from './b-research.ts';
import { OUTCOME_ENVELOPE_FORMAT } from '../outcome.ts';
import { REGISTRY } from './types.ts';

test('B: registers itself under id "B"', () => {
  assert.equal(REGISTRY.B, handler);
});

test('B: build() config — read-only except the ingest MCP action', () => {
  const out = handler.build('research SQLite WAL', { repoRoot: '/repo' });
  assert.equal(handler.trigger, 'autonomous');
  assert.equal(out.permissionMode, 'default');
  assert.deepEqual(out.allowedTools, [
    'WebSearch',
    'WebFetch',
    'Read',
    'mcp__robin-extension__ingest',
  ]);
  // Structurally read-only: every write builtin is denied (allowedTools does not gate builtins).
  assert.deepEqual(out.disallowedTools, [
    'Write',
    'Edit',
    'MultiEdit',
    'NotebookEdit',
    'Bash',
    'KillBash',
  ]);
  assert.equal(out.cwd, '/repo');
  assert.equal(out.maxTurns, 22);
  assert.equal(out.timeoutMs, 1_800_000);
  assert.equal(out.maxBudgetUsd, 3);
  assert.equal(out.outputFormat, OUTCOME_ENVELOPE_FORMAT);
});
