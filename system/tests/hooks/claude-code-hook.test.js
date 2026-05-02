// Tests for the Claude Code lifecycle hook handler.
//
// Two modes:
//   --on-pre-tool-use: blocks Write/Edit targeting ~/.claude/projects/.../memory/
//   --on-stop: drains auto-memory in the background

import { describe, it, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const HOOK = join(REPO_ROOT, 'system', 'scripts', 'hooks', 'claude-code.js');

function runHook(args, stdin = '') {
  const r = spawnSync('node', [HOOK, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    input: stdin,
  });
  return { exit: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe('claude-code-hook --on-pre-tool-use', () => {
  it('blocks Write to ~/.claude/projects/.../memory/', () => {
    const event = JSON.stringify({
      tool_name: 'Write',
      tool_input: { file_path: '/Users/iser/.claude/projects/-Users-iser-workspace-robin-robin-assistant/memory/foo.md' },
    });
    const r = runHook(['--on-pre-tool-use'], event);
    assert.equal(r.exit, 2);
    assert.match(r.stderr, /Local Memory rule/);
    assert.match(r.stderr, /forbidden/);
  });

  it('blocks Edit to auto-memory dir', () => {
    const event = JSON.stringify({
      tool_name: 'Edit',
      tool_input: { file_path: '/Users/iser/.claude/projects/abc/memory/MEMORY.md' },
    });
    const r = runHook(['--on-pre-tool-use'], event);
    assert.equal(r.exit, 2);
  });

  it('blocks NotebookEdit to auto-memory dir', () => {
    const event = JSON.stringify({
      tool_name: 'NotebookEdit',
      tool_input: { file_path: '/Users/iser/.claude/projects/abc/memory/x.md' },
    });
    const r = runHook(['--on-pre-tool-use'], event);
    assert.equal(r.exit, 2);
  });

  it('allows Write to user-data/memory/inbox.md', () => {
    const event = JSON.stringify({
      tool_name: 'Write',
      tool_input: { file_path: '/Users/iser/workspace/robin/robin-assistant/user-data/memory/inbox.md' },
    });
    const r = runHook(['--on-pre-tool-use'], event);
    assert.equal(r.exit, 0);
  });

  it('allows non-Write tool calls (e.g., Read)', () => {
    const event = JSON.stringify({
      tool_name: 'Read',
      tool_input: { file_path: '/Users/iser/.claude/projects/abc/memory/foo.md' },
    });
    const r = runHook(['--on-pre-tool-use'], event);
    assert.equal(r.exit, 0);
  });

  it('allows when stdin is malformed JSON (fail open)', () => {
    const r = runHook(['--on-pre-tool-use'], 'not json');
    assert.equal(r.exit, 0);
  });

  it('allows when input has no file_path', () => {
    const event = JSON.stringify({ tool_name: 'Write', tool_input: {} });
    const r = runHook(['--on-pre-tool-use'], event);
    assert.equal(r.exit, 0);
  });
});

describe('claude-code-hook --on-stop', () => {
  it('exits 0 immediately (drain runs in background)', () => {
    const r = runHook(['--on-stop']);
    assert.equal(r.exit, 0);
  });
});

describe('claude-code-hook usage errors', () => {
  it('exits 2 on unknown mode', () => {
    const r = runHook(['--invalid-mode']);
    assert.equal(r.exit, 2);
    assert.match(r.stderr, /Usage/);
  });

  it('exits 2 with no args', () => {
    const r = runHook([]);
    assert.equal(r.exit, 2);
  });
});

test('onStop writes session-handoff + hot.md auto-line for current claude-code session', () => {
  const ws = mkdtempSync(join(tmpdir(), 'hook-'));
  mkdirSync(join(ws, 'user-data/state'), { recursive: true });
  mkdirSync(join(ws, 'user-data/memory/self-improvement'), { recursive: true });
  const now = new Date();
  writeFileSync(join(ws, 'user-data/state/sessions.md'),
    `# Active sessions

| Session | Last active |
|---------|-------------|
| claude-code-20260430-2055 | ${now.toISOString()} |
`);
  writeFileSync(join(ws, 'user-data/memory/inbox.md'),
    `# Inbox

## Items

- [fact] entry one
- [task] entry two
`);
  writeFileSync(join(ws, 'user-data/memory/hot.md'),
    `---
description: Hot
---

# Hot
`);
  writeFileSync(join(ws, 'user-data/memory/self-improvement/session-handoff.md'),
    `---
description: Session Handoff
---

# Session Handoff
`);

  const r = spawnSync('node', [
    join(REPO_ROOT, 'system/scripts/hooks/claude-code.js'),
    '--on-stop',
    '--workspace', ws,
    '--no-drain',
  ], { encoding: 'utf8' });
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);

  const handoff = readFileSync(join(ws, 'user-data/memory/self-improvement/session-handoff.md'), 'utf8');
  assert.match(handoff, /## Session — claude-code-20260430-2055/);
  assert.match(handoff, /\(auto\)/);

  const hot = readFileSync(join(ws, 'user-data/memory/hot.md'), 'utf8');
  assert.match(hot, /## Session — claude-code-20260430-2055/);
});
