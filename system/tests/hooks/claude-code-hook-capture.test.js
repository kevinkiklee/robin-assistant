import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const HOOK = join(REPO_ROOT, 'system', 'scripts', 'hooks', 'claude-code.js');

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

describe('UserPromptSubmit handler', () => {
  it('writes turn.json with computed tier on substantive message', () => {
    const ws = mkdtempSync(join(tmpdir(), 'cc-hook-ups-'));
    mkdirSync(join(ws, 'user-data/state'), { recursive: true });
    mkdirSync(join(ws, 'user-data/memory'), { recursive: true });
    writeFileSync(join(ws, 'user-data/state/sessions.md'),
      `| claude-code-abc | ${new Date().toISOString()} |\n`);

    const event = JSON.stringify({
      session_id: 'claude-code-abc',
      user_message: 'Remember that my new dentist is Dr. Park in Hoboken',
    });
    const r = runHook(ws, ['--on-user-prompt-submit'], event);
    assert.equal(r.status, 0, r.stderr);
    const turn = JSON.parse(readFileSync(join(ws, 'user-data/state/turn.json'), 'utf8'));
    assert.equal(turn.tier, 3);
    assert.ok(turn.turn_id.startsWith('claude-code-abc:'));
  });

  it('writes turn.json with tier 1 on trivial message', () => {
    const ws = mkdtempSync(join(tmpdir(), 'cc-hook-ups-'));
    mkdirSync(join(ws, 'user-data/state'), { recursive: true });
    mkdirSync(join(ws, 'user-data/memory'), { recursive: true });
    writeFileSync(join(ws, 'user-data/state/sessions.md'),
      `| claude-code-x | ${new Date().toISOString()} |\n`);
    const event = JSON.stringify({ session_id: 'claude-code-x', user_message: 'thanks' });
    const r = runHook(ws, ['--on-user-prompt-submit'], event);
    assert.equal(r.status, 0);
    const turn = JSON.parse(readFileSync(join(ws, 'user-data/state/turn.json'), 'utf8'));
    assert.equal(turn.tier, 1);
  });

  it('emits relevant-memory block when entity in ENTITIES.md matches', () => {
    const ws = mkdtempSync(join(tmpdir(), 'cc-hook-ups-'));
    mkdirSync(join(ws, 'user-data/state'), { recursive: true });
    mkdirSync(join(ws, 'user-data/memory/profile'), { recursive: true });
    writeFileSync(join(ws, 'user-data/state/sessions.md'),
      `| claude-code-x | ${new Date().toISOString()} |\n`);
    writeFileSync(join(ws, 'user-data/memory/ENTITIES.md'),
      '---\ntype: reference\n---\n# Entities\n\n- Dr. Park (Park) — profile/dentist.md\n');
    writeFileSync(join(ws, 'user-data/memory/profile/dentist.md'),
      '---\nlast_verified: 2026-01\n---\n# Dr. Park\nDentist, JC.\n');
    const event = JSON.stringify({
      session_id: 'claude-code-x',
      user_message: 'I have a meeting with Dr. Park tomorrow at 3pm please remind me',
    });
    const r = runHook(ws, ['--on-user-prompt-submit'], event);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /<!-- relevant memory/);
    assert.match(r.stdout, /Dr\. Park/);
    assert.match(r.stdout, /profile\/dentist\.md/);
  });

  it('fails open when no session and no entities (no crash)', { timeout: 2000 }, () => {
    const ws = mkdtempSync(join(tmpdir(), 'cc-hook-ups-'));
    mkdirSync(join(ws, 'user-data/state'), { recursive: true });
    mkdirSync(join(ws, 'user-data/memory'), { recursive: true });
    const event = JSON.stringify({ session_id: 'claude-code-zzz', user_message: 'hello world test' });
    const r = runHook(ws, ['--on-user-prompt-submit'], event);
    assert.equal(r.status, 0);
  });

  it('inherits entity from previous assistant message in transcript', () => {
    const ws = mkdtempSync(join(tmpdir(), 'cc-hook-ups-'));
    mkdirSync(join(ws, 'user-data/state'), { recursive: true });
    mkdirSync(join(ws, 'user-data/memory/profile'), { recursive: true });
    writeFileSync(join(ws, 'user-data/state/sessions.md'),
      `| claude-code-x | ${new Date().toISOString()} |\n`);
    writeFileSync(join(ws, 'user-data/memory/ENTITIES.md'),
      '---\ntype: reference\n---\n# Entities\n\n- Dr. Park (Park) — profile/dentist.md\n');
    writeFileSync(join(ws, 'user-data/memory/profile/dentist.md'),
      '---\n---\n# Dr. Park\nDentist, JC.\n');
    const tx = join(ws, 'transcript.jsonl');
    writeFileSync(tx,
      JSON.stringify({ role: 'user', content: 'who is my dentist' }) + '\n' +
      JSON.stringify({ role: 'assistant', content: 'Your dentist is Dr. Park.' }) + '\n');
    const event = JSON.stringify({
      session_id: 'claude-code-x',
      user_message: 'schedule it for next week',  // no entity here
      transcript_path: tx,
    });
    const r = runHook(ws, ['--on-user-prompt-submit'], event);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Dr\. Park/);
  });

  it('appends recall.log when injecting', () => {
    const ws = mkdtempSync(join(tmpdir(), 'cc-hook-ups-'));
    mkdirSync(join(ws, 'user-data/state'), { recursive: true });
    mkdirSync(join(ws, 'user-data/memory/profile'), { recursive: true });
    writeFileSync(join(ws, 'user-data/state/sessions.md'),
      `| claude-code-x | ${new Date().toISOString()} |\n`);
    writeFileSync(join(ws, 'user-data/memory/ENTITIES.md'),
      '---\ntype: reference\n---\n# Entities\n\n- Dr. Park — profile/dentist.md\n');
    writeFileSync(join(ws, 'user-data/memory/profile/dentist.md'),
      '---\n---\n# Dr. Park\nDentist.\n');
    const event = JSON.stringify({
      session_id: 'claude-code-x',
      user_message: 'meeting with Dr. Park tomorrow at noon',
    });
    const r = runHook(ws, ['--on-user-prompt-submit'], event);
    assert.equal(r.status, 0);
    const log = readFileSync(join(ws, 'user-data/state/recall.log'), 'utf8');
    assert.match(log, /Dr\. Park/);
  });
});

describe('Stop verifyCapture', () => {
  function setupTier3WithoutCapture() {
    const ws = mkdtempSync(join(tmpdir(), 'cc-hook-stop-'));
    mkdirSync(join(ws, 'user-data/state'), { recursive: true });
    mkdirSync(join(ws, 'user-data/memory/self-improvement'), { recursive: true });
    writeFileSync(join(ws, 'user-data/state/sessions.md'),
      `| claude-code-x | ${new Date().toISOString()} |\n`);
    writeFileSync(join(ws, 'user-data/memory/inbox.md'), '');
    writeFileSync(join(ws, 'user-data/state/turn.json'),
      JSON.stringify({ turn_id: 'claude-code-x:111', user_words: 25, tier: 3, entities_matched: [] }));
    return ws;
  }

  it('blocks (exit 2) when tier 3, no capture, no marker, retries available', () => {
    const ws = setupTier3WithoutCapture();
    const event = JSON.stringify({ session_id: 'claude-code-x' });
    const r = runHook(ws, ['--on-stop'], event);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /Capture before ending/);
  });

  it('passes (exit 0) when tier 3 + write-intent recorded', () => {
    const ws = setupTier3WithoutCapture();
    writeFileSync(join(ws, 'user-data/state/turn-writes.log'),
      `${new Date().toISOString()}\tclaude-code-x:111\tuser-data/memory/inbox.md\tEdit\n`);
    const event = JSON.stringify({ session_id: 'claude-code-x' });
    const r = runHook(ws, ['--on-stop'], event);
    assert.equal(r.status, 0, r.stderr);
  });

  it('passes (exit 0) when no-capture-needed marker found in transcript', () => {
    const ws = setupTier3WithoutCapture();
    const tx = join(ws, 'transcript.jsonl');
    writeFileSync(tx, JSON.stringify({ role: 'assistant', content: 'all done <!-- no-capture-needed: pure refactor of internal helper --> ok' }) + '\n');
    const event = JSON.stringify({ session_id: 'claude-code-x', transcript_path: tx });
    const r = runHook(ws, ['--on-stop'], event);
    assert.equal(r.status, 0, r.stderr);
  });

  it('passes (exit 0) on tier 1 trivial turn with no capture', () => {
    const ws = setupTier3WithoutCapture();
    writeFileSync(join(ws, 'user-data/state/turn.json'),
      JSON.stringify({ turn_id: 'claude-code-x:222', user_words: 2, tier: 1, entities_matched: [] }));
    const event = JSON.stringify({ session_id: 'claude-code-x' });
    const r = runHook(ws, ['--on-stop'], event);
    assert.equal(r.status, 0, r.stderr);
  });

  it('passes (exit 0) after retry budget exhausted', () => {
    const ws = setupTier3WithoutCapture();
    writeFileSync(join(ws, 'user-data/state/capture-retry.json'),
      JSON.stringify({ 'claude-code-x:111': { attempts: 1, last_at: new Date().toISOString() } }));
    const event = JSON.stringify({ session_id: 'claude-code-x' });
    const r = runHook(ws, ['--on-stop'], event);
    assert.equal(r.status, 0);
  });

  it('passes (exit 0) and skips enforcement when ROBIN_CAPTURE_ENFORCEMENT=off', () => {
    const ws = setupTier3WithoutCapture();
    const r = spawnSync('node', [HOOK, '--on-stop'], {
      cwd: ws, encoding: 'utf8',
      input: JSON.stringify({ session_id: 'claude-code-x' }),
      env: { ...process.env, ROBIN_WORKSPACE: ws, ROBIN_CAPTURE_ENFORCEMENT: 'off' },
    });
    assert.equal(r.status, 0);
  });

  it('appends a telemetry line per outcome', () => {
    const ws = setupTier3WithoutCapture();
    writeFileSync(join(ws, 'user-data/state/turn-writes.log'),
      `${new Date().toISOString()}\tclaude-code-x:111\tuser-data/memory/inbox.md\tEdit\n`);
    const event = JSON.stringify({ session_id: 'claude-code-x' });
    runHook(ws, ['--on-stop'], event);
    const log = readFileSync(join(ws, 'user-data/state/capture-enforcement.log'), 'utf8');
    assert.match(log, /captured/);
    assert.match(log, /claude-code-x:111/);
  });
});
