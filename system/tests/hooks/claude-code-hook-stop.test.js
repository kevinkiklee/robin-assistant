// Tests for the Claude Code lifecycle hook handler — --on-stop mode.
//
// Three responsibilities:
//   1. Smoke: exits 0 immediately (drain happens in background).
//   2. Per-turn stats: writes one line to turn-stats.log per completed
//      assistant turn, derived from transcript_path JSONL.
//   3. Session handoff: writes session-handoff + hot.md auto-line on
//      session end (Stop fallback for the in-session capture sweep).
//   4. Verbose-output trend log: long pure-narrative replies append to
//      telemetry/verbose-output.log; tool-use and short replies are exempt.

import { describe, it, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const HOOK = join(REPO_ROOT, 'system/scripts/hooks/claude-code.js');

function runHook(args, stdin = '') {
  const r = spawnSync('node', [HOOK, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    input: stdin,
  });
  return { exit: r.status, stdout: r.stdout, stderr: r.stderr };
}

// Build a minimal tmp workspace with ENTITIES.md + the listed topic files.
// Used here to seed an empty workspace dir for stop-hook tests; entities are
// optional but the dir layout needs to look like a Robin workspace.
function makeWorkspace(entities = []) {
  const ws = mkdtempSync(join(tmpdir(), 'hook-stop-'));
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

describe('claude-code-hook --on-stop: smoke', () => {
  it('exits 0 immediately (drain runs in background)', () => {
    const r = runHook(['--on-stop']);
    assert.equal(r.exit, 0);
  });
});

test('Stop hook writes one line to turn-stats.log per turn', async () => {
  const ws = makeWorkspace();
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
    HOOK,
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

test('Stop hook writes nothing when transcript_path is missing', async () => {
  const ws = makeWorkspace();
  const event = JSON.stringify({ session_id: 'no-tx' }); // no transcript_path

  execFileSync('node', [
    HOOK,
    '--on-stop',
    '--no-drain',
    '--workspace', ws,
  ], { input: event, encoding: 'utf8' });

  const logPath = join(ws, 'user-data/runtime/state/turn-stats.log');
  assert.equal(existsSync(logPath), false, 'no log file when transcript_path is missing');
});

test('Stop hook writes nothing when transcript has only user messages', async () => {
  const ws = makeWorkspace();
  const txDir = join(ws, 'transcript');
  mkdirSync(txDir, { recursive: true });
  const tx = join(txDir, 'session.jsonl');
  writeFileSync(tx, [
    JSON.stringify({ role: 'user', content: 'hi' }),
    JSON.stringify({ role: 'user', content: 'still hi' }),
  ].join('\n'));

  const event = JSON.stringify({ session_id: 'user-only', transcript_path: tx });
  execFileSync('node', [
    HOOK,
    '--on-stop',
    '--no-drain',
    '--workspace', ws,
  ], { input: event, encoding: 'utf8' });

  const logPath = join(ws, 'user-data/runtime/state/turn-stats.log');
  assert.equal(existsSync(logPath), false, 'no log when no assistant turn yet');
});

test('Stop hook writes nothing when transcript ends mid-turn (no final text)', async () => {
  const ws = makeWorkspace();
  const txDir = join(ws, 'transcript');
  mkdirSync(txDir, { recursive: true });
  const tx = join(txDir, 'session.jsonl');
  // Final assistant message has tool_use, no text — turn not yet complete.
  writeFileSync(tx, [
    JSON.stringify({ role: 'user', content: 'hi' }),
    JSON.stringify({ role: 'assistant', content: [
      { type: 'tool_use', name: 'Read', input: { file_path: '/x' } },
    ] }),
  ].join('\n'));

  const event = JSON.stringify({ session_id: 'mid-turn', transcript_path: tx });
  execFileSync('node', [
    HOOK,
    '--on-stop',
    '--no-drain',
    '--workspace', ws,
  ], { input: event, encoding: 'utf8' });

  const logPath = join(ws, 'user-data/runtime/state/turn-stats.log');
  assert.equal(existsSync(logPath), false, 'no log when no completed turn');
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
    HOOK,
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

test('Stop hook logs verbose-output when final-text reply exceeds threshold and turn had no tool use', async () => {
  const ws = makeWorkspace();
  const txDir = join(ws, 'transcript');
  mkdirSync(txDir, { recursive: true });
  const tx = join(txDir, 'session.jsonl');
  // Long-output, no-tool-use turn: should log.
  writeFileSync(tx, [
    JSON.stringify({ role: 'user', content: 'tell me about everything' }),
    JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'long...' }], usage: { output_tokens: 1500 } },
    }),
  ].join('\n'));

  execFileSync('node', [
    HOOK,
    '--on-stop',
    '--no-drain',
    '--workspace', ws,
  ], { input: JSON.stringify({ session_id: 'verbose-test', transcript_path: tx }), encoding: 'utf8' });

  const logPath = join(ws, 'user-data/runtime/state/telemetry/verbose-output.log');
  assert.ok(existsSync(logPath), 'verbose-output.log should exist');
  const log = readFileSync(logPath, 'utf8').trim();
  const cols = log.split('\t');
  assert.equal(cols.length, 3);
  assert.equal(cols[1], 'verbose-test');
  assert.equal(cols[2], '1500');
});

test('Stop hook does NOT log verbose-output when turn had tool use (legitimate long output)', async () => {
  const ws = makeWorkspace();
  const txDir = join(ws, 'transcript');
  mkdirSync(txDir, { recursive: true });
  const tx = join(txDir, 'session.jsonl');
  // Tool-use turn → exempt regardless of output length.
  writeFileSync(tx, [
    JSON.stringify({ role: 'user', content: 'do x' }),
    JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] },
    }),
    JSON.stringify({ role: 'user', content: '[tool_result]' }),
    JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'long...' }], usage: { output_tokens: 1500 } },
    }),
  ].join('\n'));

  execFileSync('node', [
    HOOK,
    '--on-stop',
    '--no-drain',
    '--workspace', ws,
  ], { input: JSON.stringify({ session_id: 'tool-use-test', transcript_path: tx }), encoding: 'utf8' });

  const logPath = join(ws, 'user-data/runtime/state/telemetry/verbose-output.log');
  assert.equal(existsSync(logPath), false, 'verbose-output.log should NOT be written when turn had tool use');
});

test('Stop hook does NOT log verbose-output when output_tokens are below threshold', async () => {
  const ws = makeWorkspace();
  const txDir = join(ws, 'transcript');
  mkdirSync(txDir, { recursive: true });
  const tx = join(txDir, 'session.jsonl');
  writeFileSync(tx, [
    JSON.stringify({ role: 'user', content: 'short' }),
    JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }], usage: { output_tokens: 100 } },
    }),
  ].join('\n'));

  execFileSync('node', [
    HOOK,
    '--on-stop',
    '--no-drain',
    '--workspace', ws,
  ], { input: JSON.stringify({ session_id: 'short-test', transcript_path: tx }), encoding: 'utf8' });

  const logPath = join(ws, 'user-data/runtime/state/telemetry/verbose-output.log');
  assert.equal(existsSync(logPath), false, 'verbose-output.log should NOT be written for short outputs');
});
