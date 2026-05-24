import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handler } from './b-research.ts';
import { REGISTRY } from './types.ts';

test('B: registers itself under id "B"', () => {
  assert.equal(REGISTRY.B, handler);
});

test('B: build() config — trigger, permissionMode, allowedTools', () => {
  const out = handler.build('research SQLite WAL', { repoRoot: '/repo' });
  assert.equal(handler.trigger, 'autonomous');
  assert.equal(out.permissionMode, 'plan');
  assert.deepEqual(out.allowedTools, ['WebSearch', 'WebFetch', 'Read']);
  assert.equal(out.cwd, '/repo');
  assert.equal(out.maxTurns, 20);
  assert.equal(out.timeoutMs, 1_800_000);
  assert.equal(out.maxBudgetUsd, 3);
});
