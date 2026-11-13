import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { secretsPaths } from '../store.ts';
import type { SecretWindow } from '../window.ts';

const POST = join(import.meta.dirname, 'post-tool.ts');
const KEY = 'spk_test_post_tool_value_0001';
const WITHHELD = '[output withheld: secret redaction hook error]';

function runPost(userData: string, input: unknown): { stdout: string; status: number | null } {
  const r = spawnSync('pnpm', ['exec', 'tsx', POST], {
    env: { ...process.env, ROBIN_USER_DATA_DIR: userData },
    input: typeof input === 'string' ? input : JSON.stringify(input),
    encoding: 'utf8',
  });
  return { stdout: r.stdout, status: r.status };
}

function userDataWith(win?: Partial<SecretWindow> | string): string {
  const u = mkdtempSync(join(tmpdir(), 'robin-post-'));
  if (win === undefined) return u;
  const p = secretsPaths(u).window;
  mkdirSync(dirname(p), { recursive: true });
  const full: SecretWindow = {
    sessionId: 's1',
    tabId: 7,
    provider: 'acme',
    name: 'ACME_KEY',
    scriptHashes: [],
    clipboardHashAtArm: 'c1',
    openedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    status: 'saved',
    ...(typeof win === 'string' ? {} : win),
  };
  writeFileSync(p, typeof win === 'string' ? win : JSON.stringify(full));
  return u;
}

function writeVault(u: string, body: string): void {
  mkdirSync(join(u, 'config', 'secrets'), { recursive: true });
  writeFileSync(secretsPaths(u).vault, body);
}

const closeTab = (tabId: unknown, session = 's1') => ({
  session_id: session,
  tool_name: 'mcp__claude-in-chrome__tabs_close_mcp',
  tool_input: { tabId },
  tool_response: [{ type: 'text', text: 'closed' }],
});

test('post-tool: closes the window after save + tabs_close on its tab', () => {
  const u = userDataWith({ status: 'saved' });
  const r = runPost(u, closeTab(7));
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  assert.equal(existsSync(secretsPaths(u).window), false);
});

test('post-tool: closes an aborted window on tabs_close with a string tab id', () => {
  const u = userDataWith({ status: 'aborted' });
  const r = runPost(u, closeTab('7'));
  assert.equal(r.status, 0);
  assert.equal(existsSync(secretsPaths(u).window), false);
});

test('post-tool: navigate after save keeps the window (Ruling 8)', () => {
  const u = userDataWith({ status: 'saved' });
  const r = runPost(u, {
    session_id: 's1',
    tool_name: 'mcp__claude-in-chrome__navigate',
    tool_input: { tabId: 7, url: 'https://example.test/' },
    tool_response: [{ type: 'text', text: 'ok' }],
  });
  assert.equal(r.status, 0);
  assert.equal(existsSync(secretsPaths(u).window), true);
});

test('post-tool: keeps an open (unsaved) window on tabs_close', () => {
  const u = userDataWith({ status: 'open' });
  runPost(u, closeTab(7));
  assert.equal(existsSync(secretsPaths(u).window), true);
});

test('post-tool: keeps the window for another tab, another session, or a lookalike server', () => {
  const u = userDataWith({ status: 'saved' });
  runPost(u, closeTab(8));
  runPost(u, closeTab(7, 's2'));
  runPost(u, { ...closeTab(7), tool_name: 'mcp__evil-claude-in-chrome__tabs_close_mcp' });
  assert.equal(existsSync(secretsPaths(u).window), true);
});

test('post-tool: redacts an MCP text block', () => {
  const u = userDataWith();
  writeVault(u, `SOME_NAME=${KEY}\n`);
  const r = runPost(u, {
    session_id: 's1',
    tool_name: 'mcp__claude-in-chrome__read_page',
    tool_input: { tabId: 3 },
    tool_response: [{ type: 'text', text: `textbox "${KEY}"` }],
  });
  assert.equal(r.status, 0);
  assert.equal(r.stdout.includes(KEY), false);
  assert.deepEqual(JSON.parse(r.stdout), {
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      updatedMCPToolOutput: [{ type: 'text', text: 'textbox "[REDACTED-SECRET]"' }],
    },
  });
});

test('post-tool: redacts Bash output with the built-in key and shape', () => {
  const u = userDataWith();
  writeVault(u, `SOME_NAME=${KEY}\n`);
  const r = runPost(u, {
    session_id: 's1',
    tool_name: 'Bash',
    tool_input: { command: 'env' },
    tool_response: { stdout: `X=${KEY}`, stderr: '', interrupted: false, isImage: false },
  });
  assert.deepEqual(JSON.parse(r.stdout), {
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      updatedToolOutput: {
        stdout: 'X=[REDACTED-SECRET]',
        stderr: '',
        interrupted: false,
        isImage: false,
      },
    },
  });
});

test('post-tool: nothing to redact prints nothing', () => {
  const u = userDataWith();
  writeVault(u, `SOME_NAME=${KEY}\n`);
  const r = runPost(u, {
    session_id: 's1',
    tool_name: 'Read',
    tool_input: { file_path: '/x' },
    tool_response: { content: 'harmless' },
  });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
});

test('post-tool: a corrupt window file still redacts and is left alone', () => {
  const u = userDataWith('{bad');
  writeVault(u, `SOME_NAME=${KEY}\n`);
  const r = runPost(u, { ...closeTab(7), tool_response: [{ type: 'text', text: KEY }] });
  assert.equal(r.status, 0);
  assert.deepEqual(JSON.parse(r.stdout).hookSpecificOutput.updatedMCPToolOutput, [
    { type: 'text', text: '[REDACTED-SECRET]' },
  ]);
  assert.equal(readFileSync(secretsPaths(u).window, 'utf8'), '{bad');
});

function brokenRedactFiles(): string {
  const u = userDataWith();
  mkdirSync(join(u, 'config', 'secrets'), { recursive: true });
  writeFileSync(secretsPaths(u).redactFiles, `${u}\n`);
  return u;
}

test('post-tool: throws → withheld notice', () => {
  const u = brokenRedactFiles();
  const r = runPost(u, {
    session_id: 's1',
    tool_name: 'mcp__claude-in-chrome__get_page_text',
    tool_input: { tabId: 3 },
    tool_response: [{ type: 'text', text: 'anything' }],
  });
  assert.equal(r.status, 0);
  assert.deepEqual(JSON.parse(r.stdout), {
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      updatedMCPToolOutput: [{ type: 'text', text: WITHHELD }],
    },
  });
});

test('post-tool: withheld MCP list keeps its blocks; an image block becomes text', () => {
  const u = brokenRedactFiles();
  const r = runPost(u, {
    session_id: 's1',
    tool_name: 'mcp__claude-in-chrome__computer',
    tool_input: { tabId: 3, action: 'screenshot' },
    tool_response: [
      { type: 'text', text: 'shot taken' },
      { type: 'image', data: 'AAAA', mimeType: 'image/png' },
    ],
  });
  assert.deepEqual(JSON.parse(r.stdout).hookSpecificOutput.updatedMCPToolOutput, [
    { type: 'text', text: WITHHELD },
    { type: 'text', text: WITHHELD },
  ]);
});

test('post-tool: withheld Read output keeps the Read shape', () => {
  const u = brokenRedactFiles();
  const r = runPost(u, {
    session_id: 's1',
    tool_name: 'Read',
    tool_input: { file_path: '/x' },
    tool_response: {
      type: 'text',
      file: { filePath: '/x', content: 'secret-ish text', numLines: 1, startLine: 1 },
    },
  });
  assert.deepEqual(JSON.parse(r.stdout).hookSpecificOutput.updatedToolOutput, {
    type: 'text',
    file: { filePath: WITHHELD, content: WITHHELD, numLines: 1, startLine: 1 },
  });
});

test('post-tool: throws on a built-in → withheld Bash-shaped notice', () => {
  const u = brokenRedactFiles();
  const r = runPost(u, {
    session_id: 's1',
    tool_name: 'Bash',
    tool_input: { command: 'ls' },
    tool_response: { stdout: 'x', stderr: '', interrupted: false, isImage: false },
  });
  assert.deepEqual(JSON.parse(r.stdout).hookSpecificOutput.updatedToolOutput, {
    stdout: WITHHELD,
    stderr: '',
    interrupted: false,
    isImage: false,
  });
});
