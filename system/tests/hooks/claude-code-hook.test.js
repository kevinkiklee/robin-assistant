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

// Build a minimal tmp workspace with ENTITIES.md + the listed topic files,
// suitable for exercising --on-user-prompt-submit recall behavior.
function makeWorkspaceWithEntities(entities) {
  const ws = mkdtempSync(join(tmpdir(), 'hook-recall-'));
  mkdirSync(join(ws, 'user-data/memory'), { recursive: true });
  const entityLines = ['---', 'description: Auto-generated entity index for fast recall lookup', 'type: reference', '---', '# Entities', ''];
  for (const e of entities) {
    entityLines.push(`- ${e.name} — ${e.file}`);
    const full = join(ws, 'user-data/memory', e.file);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, `---\ntype: entity\n---\n# ${e.name}\n\n${e.body}\n`);
  }
  writeFileSync(join(ws, 'user-data/memory/ENTITIES.md'), entityLines.join('\n') + '\n');
  return ws;
}

test('UserPromptSubmit caps recall hits at 3 and uses new preface format', () => {
  const ws = makeWorkspaceWithEntities([
    {
      name: 'Alice',
      file: 'profile/relationships.md',
      body: 'Alice likes coffee.\nAlice lives in NYC.\nAlice works at Acme.\nAlice has a dog.\nAlice runs marathons.',
    },
  ]);
  const event = JSON.stringify({
    session_id: 'test',
    user_message: 'tell me about Alice',
    transcript_path: '',
  });
  const out = execFileSync(
    'node',
    [join(REPO_ROOT, 'system/scripts/hooks/claude-code.js'), '--on-user-prompt-submit', '--workspace', ws],
    { input: event, encoding: 'utf8' },
  );

  // Preface format: <!-- relevant memory: <N> hits for <entity1>, <entity2> -->
  assert.match(out, /<!-- relevant memory: \d+ hits for Alice -->/);
  // Cap of 3: fixture has 5 matchable Alice lines, recall emits one bullet per hit,
  // so with the cap working we should get exactly 3 — not 0, not 1, not 5.
  const inner = out.split('<!-- relevant memory:')[1]?.split('<!-- /relevant memory -->')[0] ?? '';
  const hitLines = inner.split('\n').filter((l) => l.startsWith('- '));
  assert.equal(hitLines.length, 3, `expected exactly 3 hit lines, got ${hitLines.length}`);
});

test('UserPromptSubmit sanitizes "-->" in entity names so preface comment cannot break out', () => {
  const ws = makeWorkspaceWithEntities([
    {
      name: 'Bad-->Name',
      file: 'profile/relationships.md',
      body: 'Bad-->Name appeared in a log line.',
    },
  ]);
  const event = JSON.stringify({
    session_id: 'test',
    user_message: 'tell me about Bad-->Name',
    transcript_path: '',
  });
  const out = execFileSync(
    'node',
    [join(REPO_ROOT, 'system/scripts/hooks/claude-code.js'), '--on-user-prompt-submit', '--workspace', ws],
    { input: event, encoding: 'utf8' },
  );

  // The preface line itself must not contain "-->" before the closing "-->" of the comment.
  // Match the preface line and ensure its body uses "->" not "-->".
  const prefaceMatch = out.match(/<!-- relevant memory: \d+ hits for ([^\n]*?) -->/);
  assert.ok(prefaceMatch, `expected preface in output, got: ${out}`);
  assert.ok(!prefaceMatch[1].includes('-->'), `entity-name segment leaked "-->" into comment: ${prefaceMatch[1]}`);
  assert.match(prefaceMatch[1], /Bad->Name/);
});

test('Stop hook writes one line to turn-stats.log per turn', async () => {
  const ws = makeWorkspaceWithEntities([]); // empty memory is fine here; reuse helper from Task 2
  // Seed a fake transcript: one assistant turn with 2 rounds + 2 reads + 1 bash + final text.
  const txDir = join(ws, 'transcript');
  mkdirSync(txDir, { recursive: true });
  const tx = join(txDir, 'session.jsonl');
  writeFileSync(tx, [
    JSON.stringify({ role: 'user', content: 'hi' }),
    JSON.stringify({ role: 'assistant', content: [
      { type: 'tool_use', name: 'Read', input: { file_path: '/x' } },
    ] }),
    JSON.stringify({ role: 'user', content: '[tool_result]' }),
    JSON.stringify({ role: 'assistant', content: [
      { type: 'tool_use', name: 'Read', input: { file_path: '/y' } },
      { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
    ] }),
    JSON.stringify({ role: 'user', content: '[tool_result]' }),
    JSON.stringify({ role: 'assistant', content: 'final answer' }),
  ].join('\n'));

  const event = JSON.stringify({
    session_id: 'test',
    transcript_path: tx,
  });

  execFileSync('node', [
    join(REPO_ROOT, 'system/scripts/hooks/claude-code.js'),
    '--on-stop',
    '--no-drain',
    '--workspace', ws,
  ], { input: event, encoding: 'utf8' });

  const log = readFileSync(join(ws, 'user-data/runtime/state/turn-stats.log'), 'utf8');
  const lines = log.trim().split('\n');
  assert.equal(lines.length, 1);
  const cols = lines[0].split('\t');
  // <iso>\t<sessionId>\t<rounds>\t<reads>\t<recall_fired>\t<memory_read_after_recall>
  assert.equal(cols.length, 6);
  assert.equal(cols[1], 'test');
  assert.equal(cols[2], '2', 'rounds');
  assert.equal(cols[3], '2', 'reads (only Read calls; Bash excluded)');
});

test('onStop writes session-handoff + hot.md auto-line for current claude-code session', () => {
  const ws = mkdtempSync(join(tmpdir(), 'hook-'));
  mkdirSync(join(ws, 'user-data/runtime/state'), { recursive: true });
  mkdirSync(join(ws, 'user-data/memory/streams'), { recursive: true });
  mkdirSync(join(ws, 'user-data/memory/self-improvement'), { recursive: true });
  const now = new Date();
  writeFileSync(join(ws, 'user-data/runtime/state/sessions.md'),
    `# Active sessions

| Session | Last active |
|---------|-------------|
| claude-code-20260430-2055 | ${now.toISOString()} |
`);
  writeFileSync(join(ws, 'user-data/memory/streams/inbox.md'),
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
