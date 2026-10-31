import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OUTCOME_ENVELOPE_FORMAT } from '../outcome.ts';
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
  assert.equal(out.maxTurns, 22);
  assert.equal(out.timeoutMs, 1_800_000);
  assert.equal(out.maxBudgetUsd, 3);
  assert.equal(out.outputFormat, OUTCOME_ENVELOPE_FORMAT);
});

test('D: cwd is scoped to user-data/content/knowledge under repoRoot', () => {
  assert.equal(handler.build('g', { repoRoot: '/repo' }).cwd, '/repo/user-data/content/knowledge');
});

test('D: OS sandbox is on and fail-closed — cwd alone is not a write boundary', () => {
  // A live D run escaped acceptEdits into ~/.claude on 2026-07-16: without a
  // sandbox, cwd is only a default, never an enforcement. Same shape as A.
  const out = handler.build('g', { repoRoot: '/repo' });
  assert.deepEqual(out.sandbox, {
    enabled: true,
    autoAllowBashIfSandboxed: true,
    failIfUnavailable: true,
  });
});

test('D: canUseTool denies writes outside the knowledge cwd, allows inside', () => {
  const out = handler.build('g', { repoRoot: '/repo' });
  assert.equal(typeof out.canUseTool, 'function');
  const scope = '/repo/user-data/content/knowledge';
  assert.equal(out.canUseTool('Edit', { file_path: `${scope}/note.md` }).behavior, 'allow');
  assert.equal(
    out.canUseTool('Edit', { file_path: '/Users/x/.claude/memory/MEMORY.md' }).behavior,
    'deny',
  );
  assert.equal(
    out.canUseTool('Edit', { file_path: `${scope}/../../config/secrets/.env` }).behavior,
    'deny',
    'dot-dot traversal must not escape the scope',
  );
  assert.equal(out.canUseTool('Bash', { command: 'git push origin main' }).behavior, 'deny');
});
