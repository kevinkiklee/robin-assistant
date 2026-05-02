// Cycle-2a: --on-pre-bash mode end-to-end.
//
// Spawns the hook script with synthetic JSON events on stdin and asserts
// exit code + refusal-log behavior.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOK_SCRIPT = resolve(__dirname, '..', '..', 'scripts', 'hooks', 'claude-code.js');

function ws() { return mkdtempSync(join(tmpdir(), 'bash-hook-')); }
function clean(p) { rmSync(p, { recursive: true, force: true }); }

function runHook(workspaceDir, cmd) {
  const event = { tool_name: 'Bash', tool_input: { command: cmd } };
  const result = spawnSync('node', [HOOK_SCRIPT, '--on-pre-bash', '--workspace', workspaceDir], {
    input: JSON.stringify(event),
    encoding: 'utf8',
  });
  return result;
}

test('--on-pre-bash: passes benign commands (exit 0)', () => {
  const w = ws();
  try {
    const r = runHook(w, 'ls -la');
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}; stderr: ${r.stderr}`);
    // No refusal log entry.
    const log = join(w, 'user-data/runtime/state/telemetry/policy-refusals.log');
    assert.equal(existsSync(log), false);
  } finally {
    clean(w);
  }
});

test('--on-pre-bash: blocks secrets-read with exit 2 + refusal log entry', () => {
  const w = ws();
  try {
    const r = runHook(w, 'cat user-data/runtime/secrets/.env');
    assert.equal(r.status, 2, `expected exit 2, got ${r.status}`);
    assert.match(r.stderr, /POLICY_REFUSED \[bash:secrets-read\]/);
    const log = readFileSync(join(w, 'user-data/runtime/state/telemetry/policy-refusals.log'), 'utf-8');
    assert.match(log, /\tbash\t/);
    assert.match(log, /\tsecrets-read\t/);
  } finally {
    clean(w);
  }
});

test('--on-pre-bash: blocks env-dump (env command)', () => {
  const w = ws();
  try {
    const r = runHook(w, 'env | grep TOKEN');
    assert.equal(r.status, 2);
    assert.match(r.stderr, /POLICY_REFUSED \[bash:env-dump\]/);
  } finally {
    clean(w);
  }
});

test('--on-pre-bash: blocks destructive rm -rf', () => {
  const w = ws();
  try {
    const r = runHook(w, 'rm -rf /tmp/something');
    assert.equal(r.status, 2);
    assert.match(r.stderr, /POLICY_REFUSED \[bash:destructive-rm\]/);
  } finally {
    clean(w);
  }
});

test('--on-pre-bash: malformed stdin → fail-closed exit 2 with hook-internal-error', () => {
  const w = ws();
  try {
    const result = spawnSync('node', [HOOK_SCRIPT, '--on-pre-bash', '--workspace', w], {
      input: 'not-json',
      encoding: 'utf8',
    });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /POLICY_REFUSED \[bash:hook-internal-error\]/);
  } finally {
    clean(w);
  }
});

test('--on-pre-bash: empty command (no command in event) → exit 0 (let it through)', () => {
  const w = ws();
  try {
    const event = { tool_name: 'Bash', tool_input: {} };
    const result = spawnSync('node', [HOOK_SCRIPT, '--on-pre-bash', '--workspace', w], {
      input: JSON.stringify(event),
      encoding: 'utf8',
    });
    assert.equal(result.status, 0);
  } finally {
    clean(w);
  }
});

test('--on-pre-bash: refusal log includes content hash', () => {
  const w = ws();
  try {
    runHook(w, 'cat user-data/runtime/secrets/.env');
    const log = readFileSync(join(w, 'user-data/runtime/state/telemetry/policy-refusals.log'), 'utf-8');
    const fields = log.trim().split('\t');
    // ts, kind, target, layer, reason, contentHash
    assert.equal(fields.length, 6);
    assert.match(fields[5], /^[0-9a-f]{16}$/);  // FNV-1a-64 hex
  } finally {
    clean(w);
  }
});
