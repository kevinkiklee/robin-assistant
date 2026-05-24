import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handler } from './d-kb-curation.ts';
import { REGISTRY } from './types.ts';

test('D: registers itself under id "D"', () => {
  assert.equal(REGISTRY.D, handler);
});

test('D: build() config — trigger, permissionMode, allowedTools', () => {
  const out = handler.build('dedupe knowledge notes', { repoRoot: '/repo' });
  assert.equal(handler.trigger, 'autonomous');
  assert.equal(out.permissionMode, 'acceptEdits');
  assert.deepEqual(out.allowedTools, ['Read', 'Glob', 'Grep', 'Edit']);
  assert.equal(out.maxTurns, 20);
  assert.equal(out.timeoutMs, 1_800_000);
  assert.equal(out.maxBudgetUsd, 3);
});

test('D: cwd is scoped to user-data/content/knowledge under repoRoot', () => {
  assert.equal(
    handler.build('g', { repoRoot: '/repo' }).cwd,
    '/repo/user-data/content/knowledge',
  );
});
