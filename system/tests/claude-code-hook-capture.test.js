import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');
const HOOK = join(REPO_ROOT, 'system', 'scripts', 'claude-code-hook.js');

function makeWs() {
  const ws = mkdtempSync(join(tmpdir(), 'cc-hook-cap-'));
  mkdirSync(join(ws, 'user-data/state'), { recursive: true });
  mkdirSync(join(ws, 'user-data/memory'), { recursive: true });
  writeFileSync(join(ws, 'user-data/memory/inbox.md'), '');
  writeFileSync(join(ws, 'user-data/state/turn.json'),
    JSON.stringify({ turn_id: 't1', user_words: 30, tier: 3, entities_matched: [] }));
  return ws;
}

function runHook(ws, args, stdin = '') {
  return spawnSync('node', [HOOK, ...args], {
    cwd: ws,
    encoding: 'utf8',
    input: stdin,
    env: { ...process.env, ROBIN_WORKSPACE: ws },
  });
}

describe('PreToolUse write-intent logging', () => {
  it('appends to turn-writes.log when Edit targets user-data/memory/', () => {
    const ws = makeWs();
    const event = JSON.stringify({
      tool_name: 'Edit',
      tool_input: { file_path: join(ws, 'user-data/memory/inbox.md'), new_string: 'hello' },
    });
    const r = runHook(ws, ['--on-pre-tool-use'], event);
    assert.equal(r.status, 0, r.stderr);
    const log = readFileSync(join(ws, 'user-data/state/turn-writes.log'), 'utf8');
    assert.match(log, /\tt1\t/);
    assert.match(log, /inbox\.md/);
    assert.match(log, /\tEdit\n/);
  });

  it('does NOT log writes outside user-data/memory/', () => {
    const ws = makeWs();
    const event = JSON.stringify({
      tool_name: 'Edit',
      tool_input: { file_path: join(ws, 'user-data/state/something.md'), new_string: 'x' },
    });
    runHook(ws, ['--on-pre-tool-use'], event);
    assert.equal(existsSync(join(ws, 'user-data/state/turn-writes.log')), false);
  });

  it('logs Bash redirections to user-data/memory/', () => {
    const ws = makeWs();
    const event = JSON.stringify({
      tool_name: 'Bash',
      tool_input: { command: 'echo "[fact] x" >> user-data/memory/inbox.md' },
    });
    const r = runHook(ws, ['--on-pre-bash'], event);
    assert.equal(r.status, 0, r.stderr);
    const log = readFileSync(join(ws, 'user-data/state/turn-writes.log'), 'utf8');
    assert.match(log, /\tt1\t/);
    assert.match(log, /\tbash\n/);
  });

  it('still blocks PII writes (existing behavior unchanged)', () => {
    const ws = makeWs();
    const event = JSON.stringify({
      tool_name: 'Write',
      tool_input: {
        file_path: join(ws, 'user-data/memory/inbox.md'),
        content: 'SSN 123-45-6789',
      },
    });
    const r = runHook(ws, ['--on-pre-tool-use'], event);
    // PII detection blocks before write-intent logging runs.
    assert.equal(r.status, 2);
  });
});
