import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { secretsPaths } from '../store.ts';

const GUARD = join(import.meta.dirname, 'guard.ts');

function runGuard(userData: string, input: unknown): { stdout: string; status: number | null } {
  const r = spawnSync('pnpm', ['exec', 'tsx', GUARD], {
    env: { ...process.env, ROBIN_USER_DATA_DIR: userData },
    input: JSON.stringify(input),
    encoding: 'utf8',
  });
  return { stdout: r.stdout, status: r.status };
}

const readCall = { session_id: 's1', tool_name: 'Read', tool_input: { file_path: '/x' } };

test('guard: checker error with window file present denies', () => {
  const u = mkdtempSync(join(tmpdir(), 'robin-guard-'));
  const p = secretsPaths(u).window;
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, '{bad');
  const r = runGuard(u, readCall);
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
});

test('guard: no window and an ordinary call prints nothing', () => {
  const u = mkdtempSync(join(tmpdir(), 'robin-guard-'));
  const r = runGuard(u, readCall);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  assert.equal(existsSync(secretsPaths(u).armSession), false);
});

test('guard: no window and robin secret arm records the session', () => {
  const u = mkdtempSync(join(tmpdir(), 'robin-guard-'));
  const r = runGuard(u, {
    session_id: 's1',
    tool_name: 'Bash',
    tool_input: { command: 'robin secret arm --tab 7' },
  });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  assert.equal(existsSync(secretsPaths(u).armSession), true);
});

test('guard: unparseable stdin with window file present denies', () => {
  const u = mkdtempSync(join(tmpdir(), 'robin-guard-'));
  const p = secretsPaths(u).window;
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, '{}');
  const r = spawnSync('pnpm', ['exec', 'tsx', GUARD], {
    env: { ...process.env, ROBIN_USER_DATA_DIR: u },
    input: 'not json',
    encoding: 'utf8',
  });
  assert.equal(r.status, 0);
  assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, 'deny');
});
