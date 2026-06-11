import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handler } from './g-gap-fill.ts';
import { OUTCOME_ENVELOPE_FORMAT } from '../outcome.ts';
import { REGISTRY } from './types.ts';

test('G: registers itself under id "G"', () => {
  assert.equal(REGISTRY.G, handler);
});

test('G: build() config — trigger, permissionMode, allowedTools', () => {
  const out = handler.build('fill gap on entity X', { repoRoot: '/repo' });
  assert.equal(handler.trigger, 'autonomous');
  assert.equal(out.permissionMode, 'acceptEdits');
  assert.deepEqual(out.allowedTools, ['WebSearch', 'WebFetch', 'Read', 'Glob', 'Grep', 'Edit']);
  assert.equal(out.maxTurns, 27);
  assert.equal(out.timeoutMs, 1_800_000);
  assert.equal(out.maxBudgetUsd, 4);
  assert.equal(out.outputFormat, OUTCOME_ENVELOPE_FORMAT);
});

test('G: cwd is scoped to user-data/content/knowledge under repoRoot', () => {
  assert.equal(handler.build('g', { repoRoot: '/repo' }).cwd, '/repo/user-data/content/knowledge');
});
