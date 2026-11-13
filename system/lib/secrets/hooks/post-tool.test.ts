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
const WITHHELD =
  '[output withheld: secret redaction hook error — run `robin secret uninstall` to disable redaction]';
const fileNotice = (u: string) =>
  `[output withheld: the secret redaction hook could not read ${secretsPaths(u).vault} — fix it, or run \`robin secret uninstall\` to disable redaction]`;

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

/** A vault that exists but can't be read (a directory: EISDIR) → every output is withheld. */
function brokenVault(): string {
  const u = userDataWith();
  mkdirSync(secretsPaths(u).vault, { recursive: true });
  return u;
}

function withheld(u: string, payload: Record<string, unknown>): unknown {
  const r = runPost(u, { session_id: 's1', tool_input: {}, ...payload });
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout).hookSpecificOutput;
  return out.updatedMCPToolOutput ?? out.updatedToolOutput;
}

test('post-tool: a directory listed in redact-files is expanded, not a reason to withhold', () => {
  const u = userDataWith();
  writeVault(u, `SOME_NAME=${KEY}\n`);
  const dir = join(u, 'keys');
  mkdirSync(dir);
  writeFileSync(join(dir, 'other.key'), 'spk_test_listed_dir_value_01\n');
  writeFileSync(secretsPaths(u).redactFiles, `${dir}\n${join(u, 'gone')}\n`);
  const r = runPost(u, {
    session_id: 's1',
    tool_name: 'Bash',
    tool_input: { command: 'env' },
    tool_response: {
      stdout: `X=${KEY} Y=spk_test_listed_dir_value_01`,
      stderr: '',
      interrupted: false,
      isImage: false,
    },
  });
  assert.equal(
    JSON.parse(r.stdout).hookSpecificOutput.updatedToolOutput.stdout,
    'X=[REDACTED-SECRET] Y=[REDACTED-SECRET]',
  );
});

test('post-tool: an ENOTDIR listed path still withholds, naming that path', () => {
  const u = userDataWith();
  const plain = join(u, 'plain');
  writeFileSync(plain, 'x\n');
  mkdirSync(join(u, 'config', 'secrets'), { recursive: true });
  writeFileSync(secretsPaths(u).redactFiles, `${join(plain, 'child')}\n`);
  const out = withheld(u, {
    tool_name: 'mcp__x__y',
    tool_response: [{ type: 'text', text: 'anything' }],
  }) as { text: string }[];
  assert.match(
    out[0].text,
    /could not read .*plain\/child — fix it, or run `robin secret uninstall`/,
  );
});

test('post-tool: unreadable vault → withheld notice names the file and the uninstall command', () => {
  const u = brokenVault();
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
      updatedMCPToolOutput: [{ type: 'text', text: fileNotice(u) }],
    },
  });
  assert.match(fileNotice(u), /robin secret uninstall/);
});

test('post-tool: unparseable payload → generic withheld notice', () => {
  const u = userDataWith();
  const r = runPost(u, 'not json "tool_name":"mcp__x"');
  assert.deepEqual(JSON.parse(r.stdout).hookSpecificOutput.updatedMCPToolOutput, [
    { type: 'text', text: WITHHELD },
  ]);
});

test('post-tool: withheld MCP output with an image anywhere → one text block', () => {
  const u = brokenVault();
  const out = withheld(u, {
    tool_name: 'mcp__claude-in-chrome__computer',
    tool_input: { tabId: 3, action: 'screenshot' },
    tool_response: [
      { type: 'text', text: 'shot taken of the page' },
      { type: 'image', data: 'AAAA', mimeType: 'image/png' },
    ],
  });
  assert.deepEqual(out, [{ type: 'text', text: fileNotice(u) }]);
});

test('post-tool: withheld Bash output keeps every real key, never renamed', () => {
  const u = brokenVault();
  const n = fileNotice(u);
  const out = withheld(u, {
    tool_name: 'Bash',
    tool_input: { command: 'ls' },
    tool_response: {
      stdout: 'lin_api_FAKE0123456789abcdefFAKE0123456789',
      stderr: '',
      interrupted: false,
      isImage: false,
      noOutputExpected: false,
      returnCodeInterpretation: 'No matches found in the files',
      persistedOutputPath: '/private/tmp/claude/tool-results/out-0001.txt',
      staleReadFileStateHint: 'The file changed since it was last read',
      backgroundCwdHint: 'The shell cwd moved to /some/other/folder',
    },
  });
  assert.deepEqual(out, {
    stdout: n,
    stderr: '',
    interrupted: false,
    isImage: false,
    noOutputExpected: false,
    returnCodeInterpretation: n,
    persistedOutputPath: n,
    staleReadFileStateHint: n,
    backgroundCwdHint: n,
  });
});

test('post-tool: withheld Edit and Write outputs keep contentNotInModelContext and every key', () => {
  const u = brokenVault();
  const n = fileNotice(u);
  const edit = withheld(u, {
    tool_name: 'Edit',
    tool_response: {
      filePath: '/Users/someone/project/src/app.ts',
      oldString: 'const a = 1; // old',
      newString: 'const a = 2; // new',
      originalFile: 'the whole original file text',
      structuredPatch: [
        { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-const a = 1; // old'] },
      ],
      userModified: false,
      replaceAll: false,
      contentNotInModelContext: true,
    },
  });
  assert.deepEqual(edit, {
    filePath: n,
    oldString: n,
    newString: n,
    originalFile: n,
    structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: [n] }],
    userModified: false,
    replaceAll: false,
    contentNotInModelContext: true,
  });
  const write = withheld(u, {
    tool_name: 'Write',
    tool_response: {
      type: 'create',
      filePath: '/Users/someone/project/new-file.ts',
      content: 'export const value = "something long";',
      structuredPatch: [],
      originalFile: null,
      contentNotInModelContext: true,
    },
  });
  assert.deepEqual(write, {
    type: 'create',
    filePath: n,
    content: n,
    structuredPatch: [],
    originalFile: null,
    contentNotInModelContext: true,
  });
});

test('post-tool: withheld Grep output keeps mode and identifier-like enum values', () => {
  const u = brokenVault();
  const n = fileNotice(u);
  const content = withheld(u, {
    tool_name: 'Grep',
    tool_response: {
      mode: 'content',
      numFiles: 2,
      filenames: ['/Users/someone/project/a.ts'],
      content: 'a.ts:1:some matching line of text',
      numLines: 1,
    },
  });
  assert.deepEqual(content, {
    mode: 'content',
    numFiles: 2,
    filenames: [n],
    content: n,
    numLines: 1,
  });
  const files = withheld(u, {
    tool_name: 'Grep',
    tool_response: { mode: 'files_with_matches', filenames: [], numFiles: 0 },
  }) as { mode: string };
  assert.equal(files.mode, 'files_with_matches');
  const enum32 = `a${'b'.repeat(31)}`;
  const enum33 = `a${'b'.repeat(32)}`;
  assert.deepEqual(
    withheld(u, {
      tool_name: 'X',
      tool_response: {
        mode: enum32,
        type: enum33,
        returnCodeInterpretation: 'Capitalized_value',
        name: 'spk_test_t12', // a 12-char vault-like value under an unknown key
        id: 'sk-ant-api03-FAKE',
        n: 3,
        ok: true,
        none: null,
        empty: '',
      },
    }),
    {
      mode: enum32,
      type: n,
      returnCodeInterpretation: n,
      name: n,
      id: n,
      n: 3,
      ok: true,
      none: null,
      empty: '',
    },
  );
});

test('post-tool: withheld Read text keeps the Read text shape', () => {
  const u = brokenVault();
  const n = fileNotice(u);
  const out = withheld(u, {
    tool_name: 'Read',
    tool_input: { file_path: '/x' },
    tool_response: {
      type: 'text',
      file: {
        filePath: '/x',
        content: 'secret-ish text that is long',
        numLines: 1,
        startLine: 1,
        totalLines: 1,
      },
    },
  });
  assert.deepEqual(out, {
    type: 'text',
    file: { filePath: n, content: n, numLines: 1, startLine: 1, totalLines: 1 },
  });
});

test('post-tool: withheld Read image becomes a Read text result', () => {
  const u = brokenVault();
  const out = withheld(u, {
    tool_name: 'Read',
    tool_input: { file_path: '/Users/someone/shots/screen.png' },
    tool_response: {
      type: 'image',
      file: {
        base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB',
        type: 'image/png',
        originalSize: 1234,
        dimensions: { originalWidth: 10, originalHeight: 10 },
      },
    },
  });
  assert.deepEqual(out, {
    type: 'text',
    file: {
      filePath: '/Users/someone/shots/screen.png',
      content: fileNotice(u),
      numLines: 1,
      startLine: 1,
      totalLines: 1,
    },
  });
});

test('post-tool: withheld Bash image output becomes Bash text, other keys kept', () => {
  const u = brokenVault();
  const out = withheld(u, {
    tool_name: 'Bash',
    tool_input: { command: 'screencapture -' },
    tool_response: {
      stdout: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg',
      stderr: '',
      interrupted: false,
      isImage: true,
      noOutputExpected: false,
    },
  });
  assert.deepEqual(out, {
    stdout: fileNotice(u),
    stderr: '',
    interrupted: false,
    isImage: false,
    noOutputExpected: false,
  });
});

test('post-tool: withheld Bash keeps an enum returnCodeInterpretation, blanks a key-shaped stdout', () => {
  const u = brokenVault();
  const out = withheld(u, {
    tool_name: 'Bash',
    tool_response: {
      stdout: 'lin_api_FAKE0123456789abcdef',
      stderr: 'short',
      interrupted: false,
      isImage: false,
      returnCodeInterpretation: 'no_matches',
    },
  });
  assert.deepEqual(out, {
    stdout: fileNotice(u),
    stderr: fileNotice(u),
    interrupted: false,
    isImage: false,
    returnCodeInterpretation: 'no_matches',
  });
});

// I3: any binary payload gets the text form, not just images.
test('post-tool: withheld Read of a PDF becomes a Read text result', () => {
  const u = brokenVault();
  const out = withheld(u, {
    tool_name: 'Read',
    tool_input: { file_path: '/Users/someone/docs/manual.pdf' },
    tool_response: {
      type: 'pdf',
      file: {
        filePath: '/Users/someone/docs/manual.pdf',
        base64: 'JVBERi0xLjcKJcfsj6IKNSAwIG9iago8PA',
        originalSize: 4321,
      },
    },
  });
  assert.deepEqual(out, {
    type: 'text',
    file: {
      filePath: '/Users/someone/docs/manual.pdf',
      content: fileNotice(u),
      numLines: 1,
      startLine: 1,
      totalLines: 1,
    },
  });
});

test('post-tool: withheld MCP output with a binary resource blob → one text block', () => {
  const u = brokenVault();
  const out = withheld(u, {
    tool_name: 'mcp__files__read_resource',
    tool_response: [
      { type: 'text', text: 'here it is' },
      { type: 'resource', resource: { uri: 'file:///x.bin', blob: 'AAECAwQF' } },
    ],
  });
  assert.deepEqual(out, [{ type: 'text', text: fileNotice(u) }]);
});

test('post-tool: withheld MCP audio block (data) → one text block', () => {
  const u = brokenVault();
  const out = withheld(u, {
    tool_name: 'mcp__sound__record',
    tool_response: [{ type: 'audio', data: 'UklGRiQAAABXQVZF', mimeType: 'audio/wav' }],
  });
  assert.deepEqual(out, [{ type: 'text', text: fileNotice(u) }]);
});
