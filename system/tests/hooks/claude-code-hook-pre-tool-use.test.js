// Tests for the Claude Code lifecycle hook handler — --on-pre-tool-use mode.
//
// Blocks Write/Edit/NotebookEdit targeting host auto-memory dirs and
// misrouted artifacts/backup paths under the workspace root. Allows
// non-write tools and unrelated paths.
//
// Also covers the dispatcher's usage-error contract (unknown mode / no
// args), since those errors share the runHook helper used here.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
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

  it('blocks Write to bare <workspace>/artifacts/* (suggests user-data/artifacts/)', () => {
    const ws = mkdtempSync(join(tmpdir(), 'hook-art-'));
    const event = JSON.stringify({
      tool_name: 'Write',
      tool_input: { file_path: join(ws, 'artifacts/output/foo.png') },
    });
    const r = spawnSync('node', [HOOK, '--on-pre-tool-use'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      input: event,
      env: { ...process.env, ROBIN_WORKSPACE: ws },
    });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /WRITE_REFUSED \[artifacts\]/);
    assert.match(r.stderr, /user-data\/artifacts\/output\/foo\.png/);
  });

  it('allows Write to <workspace>/user-data/artifacts/*', () => {
    const ws = mkdtempSync(join(tmpdir(), 'hook-art-ok-'));
    const event = JSON.stringify({
      tool_name: 'Write',
      tool_input: { file_path: join(ws, 'user-data/artifacts/output/foo.png') },
    });
    const r = spawnSync('node', [HOOK, '--on-pre-tool-use'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      input: event,
      env: { ...process.env, ROBIN_WORKSPACE: ws },
    });
    assert.equal(r.status, 0);
  });

  it('blocks Write to bare <workspace>/backup/* (suggests user-data/backup/)', () => {
    const ws = mkdtempSync(join(tmpdir(), 'hook-bk-'));
    const event = JSON.stringify({
      tool_name: 'Write',
      tool_input: { file_path: join(ws, 'backup/snapshot.tar.gz') },
    });
    const r = spawnSync('node', [HOOK, '--on-pre-tool-use'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      input: event,
      env: { ...process.env, ROBIN_WORKSPACE: ws },
    });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /WRITE_REFUSED \[backup\]/);
    assert.match(r.stderr, /user-data\/backup\/snapshot\.tar\.gz/);
  });

  it('blocks misrouted path inside an MCP-style nested tool_input', () => {
    const ws = mkdtempSync(join(tmpdir(), 'hook-mcp-'));
    const event = JSON.stringify({
      tool_name: 'mcp__gemini-nano-banana__generate_image',
      tool_input: {
        prompt: 'a photo',
        output: { save_to: join(ws, 'artifacts/output/image.png') },
      },
    });
    const r = spawnSync('node', [HOOK, '--on-pre-tool-use'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      input: event,
      env: { ...process.env, ROBIN_WORKSPACE: ws },
    });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /WRITE_REFUSED \[artifacts\]/);
  });

  it('allows Write to user-data/memory/streams/inbox.md', () => {
    const event = JSON.stringify({
      tool_name: 'Write',
      tool_input: { file_path: '/Users/iser/workspace/robin/robin-assistant/user-data/memory/streams/inbox.md' },
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
