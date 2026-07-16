import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OUTCOME_ENVELOPE_FORMAT } from '../outcome.ts';
import { handler } from './g-gap-fill.ts';
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

test('G: OS sandbox is on and fail-closed — cwd alone is not a write boundary', () => {
  const out = handler.build('g', { repoRoot: '/repo' });
  assert.deepEqual(out.sandbox, {
    enabled: true,
    autoAllowBashIfSandboxed: true,
    failIfUnavailable: true,
  });
});

test('G: canUseTool denies writes outside the knowledge cwd, allows inside', () => {
  const out = handler.build('g', { repoRoot: '/repo' });
  assert.equal(typeof out.canUseTool, 'function');
  const scope = '/repo/user-data/content/knowledge';
  assert.equal(out.canUseTool('Write', { file_path: `${scope}/new-note.md` }).behavior, 'allow');
  assert.equal(
    out.canUseTool('Edit', { file_path: '/Users/x/.claude/memory/MEMORY.md' }).behavior,
    'deny',
  );
  assert.equal(out.canUseTool('Bash', { command: 'rm -rf /' }).behavior, 'deny');
});
