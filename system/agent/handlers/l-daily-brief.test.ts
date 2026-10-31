import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OUTCOME_ENVELOPE_FORMAT } from '../outcome.ts';
import { handler } from './l-daily-brief.ts';
import { REGISTRY } from './types.ts';

test('L: registers itself under id "L"', () => {
  assert.equal(REGISTRY.L, handler);
});

test('L: build() config — trigger, permissionMode, allowedTools', () => {
  const out = handler.build('compose the morning brief', { repoRoot: '/repo' });
  assert.equal(handler.trigger, 'autonomous');
  assert.equal(out.permissionMode, 'plan');
  assert.deepEqual(out.allowedTools, [
    'mcp__robin__recall',
    'mcp__robin-extension__gmail',
    'mcp__robin-extension__google_calendar',
    'mcp__robin-extension__linear',
  ]);
  assert.equal(out.maxTurns, 22);
  assert.equal(out.timeoutMs, 1_800_000);
  assert.equal(out.maxBudgetUsd, 3);
  assert.equal(out.outputFormat, OUTCOME_ENVELOPE_FORMAT);
});
