import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OUTCOME_ENVELOPE_FORMAT } from '../outcome.ts';
import { handler } from './e-belief-reconcile.ts';
import { REGISTRY } from './types.ts';

test('E: registers itself under id "E"', () => {
  assert.equal(REGISTRY.E, handler);
});

test('E: build() config — trigger, permissionMode, allowedTools', () => {
  const out = handler.build('reconcile conflicting beliefs', { repoRoot: '/repo' });
  assert.equal(handler.trigger, 'autonomous');
  assert.equal(out.permissionMode, 'default');
  assert.deepEqual(out.allowedTools, [
    'mcp__robin__recall',
    'mcp__robin__recall_belief',
    'mcp__robin__review_beliefs',
    'mcp__robin__find_entity',
    'mcp__robin__list',
    'mcp__robin-extension__related_entities',
    'mcp__robin__believe',
    'mcp__robin__record_correction',
  ]);
  assert.equal(out.cwd, '/repo');
  assert.equal(out.maxTurns, 22);
  assert.equal(out.timeoutMs, 1_800_000);
  assert.equal(out.maxBudgetUsd, 3);
  assert.equal(out.outputFormat, OUTCOME_ENVELOPE_FORMAT);
});
