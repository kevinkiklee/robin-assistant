// system/tests/golden-session-capture.test.js
//
// End-to-end: simulate a 4-turn session through the hook handler and verify
// capture enforcement + auto-recall produce the right state.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');
const HOOK = join(REPO_ROOT, 'system', 'scripts', 'hooks', 'claude-code.js');
const SAMPLE_MEM = join(REPO_ROOT, 'system/tests/fixtures/sample-memory');

function makeWorkspace() {
  const ws = mkdtempSync(join(tmpdir(), 'golden-cap-'));
  mkdirSync(join(ws, 'user-data/state'), { recursive: true });
  mkdirSync(join(ws, 'user-data/memory'), { recursive: true });
  cpSync(SAMPLE_MEM, join(ws, 'user-data/memory'), { recursive: true });
  writeFileSync(join(ws, 'user-data/state/sessions.md'),
    `| claude-code-golden | ${new Date().toISOString()} |\n`);
  writeFileSync(join(ws, 'user-data/memory/inbox.md'), '');
  // Generate ENTITIES.md from sample fixtures.
  spawnSync('node', [join(REPO_ROOT, 'system/scripts/index-entities.js'), '--regenerate'], {
    cwd: ws, env: { ...process.env, ROBIN_WORKSPACE: ws }, encoding: 'utf8',
  });
  return ws;
}

function runHook(ws, args, stdin) {
  return spawnSync('node', [HOOK, ...args], {
    cwd: ws, encoding: 'utf8', input: stdin,
    env: { ...process.env, ROBIN_WORKSPACE: ws },
  });
}

describe('golden-session-capture (E2E)', () => {
  it('full 4-turn flow: trivial → substantive-with-capture → substantive-without → recovery', () => {
    const ws = makeWorkspace();

    // Turn 1: trivial → tier 1 → Stop passes immediately.
    let r = runHook(ws, ['--on-user-prompt-submit'],
      JSON.stringify({ session_id: 'claude-code-golden', user_message: 'thanks' }));
    assert.equal(r.status, 0);
    r = runHook(ws, ['--on-stop'], JSON.stringify({ session_id: 'claude-code-golden' }));
    assert.equal(r.status, 0);

    // Turn 2: substantive + entity match → auto-recall fires; PreToolUse logs Edit; Stop passes.
    r = runHook(ws, ['--on-user-prompt-submit'],
      JSON.stringify({ session_id: 'claude-code-golden',
        user_message: 'I have a meeting with Dr. Park tomorrow at 3pm please confirm the address' }));
    assert.equal(r.status, 0);
    assert.match(r.stdout, /relevant memory/);
    assert.match(r.stdout, /Dr\. Park/);

    r = runHook(ws, ['--on-pre-tool-use'], JSON.stringify({
      tool_name: 'Edit',
      tool_input: { file_path: join(ws, 'user-data/memory/inbox.md'), new_string: '- [task|origin=user] confirm dentist address' },
    }));
    assert.equal(r.status, 0);
    r = runHook(ws, ['--on-stop'], JSON.stringify({ session_id: 'claude-code-golden' }));
    assert.equal(r.status, 0);

    // Turn 3: substantive, no capture, no marker → Stop blocks (exit 2).
    r = runHook(ws, ['--on-user-prompt-submit'],
      JSON.stringify({ session_id: 'claude-code-golden',
        user_message: 'I decided to switch from Vanguard to Fidelity for the new account I opened last week' }));
    assert.equal(r.status, 0);
    r = runHook(ws, ['--on-stop'], JSON.stringify({ session_id: 'claude-code-golden' }));
    assert.equal(r.status, 2);
    assert.match(r.stderr, /Capture before ending/);

    // Turn 3 retry: marker present → Stop passes.
    const tx = join(ws, 'transcript.jsonl');
    writeFileSync(tx, JSON.stringify({ role: 'assistant', content: 'noted <!-- no-capture-needed: superseded by next message --> done' }) + '\n');
    r = runHook(ws, ['--on-stop'], JSON.stringify({ session_id: 'claude-code-golden', transcript_path: tx }));
    assert.equal(r.status, 0);

    // capture-enforcement.log has at least 4 outcome lines.
    const log = readFileSync(join(ws, 'user-data/state/capture-enforcement.log'), 'utf8').trim().split('\n');
    assert.ok(log.length >= 4, `expected ≥4 enforcement lines, got ${log.length}`);
    assert.ok(log.some((l) => l.includes('skipped-trivial')));
    assert.ok(log.some((l) => l.includes('captured')));
    assert.ok(log.some((l) => l.includes('retried')));
    assert.ok(log.some((l) => l.includes('marker-pass')));
  });
});
