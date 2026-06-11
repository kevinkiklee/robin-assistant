import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OUTCOME_ENVELOPE_FORMAT } from '../outcome.ts';
import { handler } from './f-prediction-calibrate.ts';
import { REGISTRY } from './types.ts';

test('F: registers itself under id "F"', () => {
  assert.equal(REGISTRY.F, handler);
});

test('F: build() config — trigger, permissionMode, allowedTools', () => {
  const out = handler.build('resolve open predictions', { repoRoot: '/repo' });
  assert.equal(handler.trigger, 'autonomous');
  assert.equal(out.permissionMode, 'default');
  assert.deepEqual(out.allowedTools, [
    'mcp__robin__recall',
    'mcp__robin__predict',
    'mcp__robin-extension__resolve_prediction',
    'WebSearch',
    'WebFetch',
  ]);
  assert.equal(out.cwd, '/repo');
  assert.equal(out.maxTurns, 22);
  assert.equal(out.timeoutMs, 1_800_000);
  assert.equal(out.maxBudgetUsd, 3);
  assert.equal(out.outputFormat, OUTCOME_ENVELOPE_FORMAT);
});
