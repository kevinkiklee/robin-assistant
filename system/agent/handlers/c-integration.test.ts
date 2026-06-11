import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OUTCOME_ENVELOPE_FORMAT } from '../outcome.ts';
import { handler } from './c-integration.ts';
import { REGISTRY } from './types.ts';

test('C: registers itself under id "C"', () => {
  assert.equal(REGISTRY.C, handler);
});

test('C: build() config — trigger, permissionMode, allowedTools', () => {
  const out = handler.build('triage my inbox into linear', { repoRoot: '/repo' });
  assert.equal(handler.trigger, 'on-demand');
  assert.equal(out.permissionMode, 'default');
  assert.deepEqual(out.allowedTools, [
    'mcp__robin-extension__gmail',
    'mcp__robin-extension__google_calendar',
    'mcp__robin-extension__linear',
    'mcp__robin-extension__chrome',
  ]);
  assert.equal(out.maxTurns, 27);
  assert.equal(out.timeoutMs, 1_800_000);
  assert.equal(out.maxBudgetUsd, 4);
  assert.equal(out.outputFormat, OUTCOME_ENVELOPE_FORMAT);
});

test('C: every allowlisted tool is a robin-extension MCP tool', () => {
  const out = handler.build('g', { repoRoot: '/repo' });
  for (const t of out.allowedTools) {
    assert.match(t, /^mcp__robin-extension__/);
  }
});
