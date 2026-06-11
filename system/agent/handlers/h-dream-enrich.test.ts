import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OUTCOME_ENVELOPE_FORMAT } from '../outcome.ts';
import { handler } from './h-dream-enrich.ts';
import { REGISTRY } from './types.ts';

test('H: registers itself under id "H"', () => {
  assert.equal(REGISTRY.H, handler);
});

test('H: build() config — trigger, permissionMode, allowedTools', () => {
  const out = handler.build('synthesize cross-session insight', { repoRoot: '/repo' });
  assert.equal(handler.trigger, 'autonomous');
  assert.equal(out.permissionMode, 'default');
  assert.deepEqual(out.allowedTools, [
    'mcp__robin__recall',
    'mcp__robin__journal',
    'mcp__robin__believe',
  ]);
  assert.equal(out.cwd, '/repo');
  assert.equal(out.maxTurns, 22);
  assert.equal(out.timeoutMs, 1_800_000);
  assert.equal(out.maxBudgetUsd, 3);
  assert.equal(out.outputFormat, OUTCOME_ENVELOPE_FORMAT);
});
