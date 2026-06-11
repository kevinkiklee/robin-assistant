import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handler } from './i-life-executor.ts';
import { OUTCOME_ENVELOPE_FORMAT } from '../outcome.ts';
import { REGISTRY } from './types.ts';

test('I: registers itself under id "I"', () => {
  assert.equal(REGISTRY.I, handler);
});

test('I: build() config — trigger, permissionMode, allowedTools', () => {
  const out = handler.build('book dinner for two on friday', { repoRoot: '/repo' });
  assert.equal(handler.trigger, 'on-demand');
  assert.equal(out.permissionMode, 'default');
  assert.deepEqual(out.allowedTools, [
    'mcp__robin-extension__gmail',
    'mcp__robin-extension__google_calendar',
    'mcp__robin-extension__spotify_write',
  ]);
  assert.equal(out.maxTurns, 27);
  assert.equal(out.timeoutMs, 1_800_000);
  assert.equal(out.maxBudgetUsd, 5);
  assert.equal(out.outputFormat, OUTCOME_ENVELOPE_FORMAT);
});
