import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyAction } from '../../scripts/capture/lib/actions/classify.js';

test('mcp tool: provider-verb extracts provider from prefix', () => {
  assert.equal(
    classifyAction({ name: 'mcp__claude_ai_Gmail__archive', input: {} }),
    'gmail-archive',
  );
  assert.equal(
    classifyAction({ name: 'mcp__claude_ai_Google_Calendar__create', input: {} }),
    'google-calendar-create',
  );
});

test('mcp tool: lowercases and kebabs CamelCase providers', () => {
  assert.equal(
    classifyAction({ name: 'mcp__GitHub__create_issue', input: {} }),
    'github-create-issue',
  );
});

test('Bash tool: prefixes shell-, uses first command token', () => {
  assert.equal(
    classifyAction({ name: 'Bash', input: { command: 'rm /tmp/foo' } }),
    'shell-rm',
  );
  assert.equal(
    classifyAction({ name: 'Bash', input: { command: 'git push --force origin main' } }),
    'shell-git-push',
  );
  assert.equal(
    classifyAction({ name: 'Bash', input: { command: 'ls -la' } }),
    'shell-ls',
  );
});

test('Bash tool: classifies rm -rf separately as shell-rm-recursive', () => {
  assert.equal(
    classifyAction({ name: 'Bash', input: { command: 'rm -rf /var/foo' } }),
    'shell-rm-recursive',
  );
  assert.equal(
    classifyAction({ name: 'Bash', input: { command: 'rm /tmp/x' } }),
    'shell-rm',
  );
});

test('Write tool: classifies by destination path', () => {
  assert.equal(
    classifyAction({ name: 'Write', input: { file_path: '/abs/user-data/memory/x.md' } }),
    'write-memory-file',
  );
  assert.equal(
    classifyAction({ name: 'Write', input: { file_path: '/abs/user-data/state/x.json' } }),
    'write-state-file',
  );
  assert.equal(
    classifyAction({ name: 'Write', input: { file_path: '/abs/some/other/path.txt' } }),
    'write-file',
  );
});

test('Edit tool: same destination-based classification as Write', () => {
  assert.equal(
    classifyAction({ name: 'Edit', input: { file_path: '/abs/user-data/memory/x.md' } }),
    'edit-memory-file',
  );
});

test('Read tool: read-only, never an action class', () => {
  assert.equal(classifyAction({ name: 'Read', input: { file_path: '/x' } }), null);
  assert.equal(classifyAction({ name: 'Grep', input: {} }), null);
  assert.equal(classifyAction({ name: 'Glob', input: {} }), null);
});

test('unknown tool returns generic slug', () => {
  assert.equal(classifyAction({ name: 'SomeNewTool', input: {} }), 'somenewtool');
});

test('null/undefined input is safe', () => {
  assert.equal(classifyAction({ name: 'Bash' }), 'shell-unknown');
  assert.equal(classifyAction({ name: 'Bash', input: { command: '' } }), 'shell-unknown');
});
