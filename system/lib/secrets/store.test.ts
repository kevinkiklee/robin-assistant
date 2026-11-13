import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  appendLog,
  assertNameAllowed,
  defaultShape,
  findShadowing,
  fingerprint,
  getMaster,
  importRobinEnv,
  isSecretClassName,
  launchctlGetenvWith,
  secretsPaths,
  setMaster,
} from './store.ts';

function tmpUserData(): string {
  const d = mkdtempSync(join(tmpdir(), 'robin-store-'));
  mkdirSync(join(d, 'config', 'secrets'), { recursive: true });
  mkdirSync(join(d, 'state', 'runtime'), { recursive: true });
  return d;
}

describe('secretsPaths', () => {
  it('places files under config/secrets and state/runtime', () => {
    const p = secretsPaths('/ud');
    assert.equal(p.vault, '/ud/config/secrets/vault.env');
    assert.equal(p.robinEnv, '/ud/config/secrets/.env');
    assert.equal(p.daemonEnv, '/ud/config/secrets/daemon.env');
    assert.equal(p.redactFiles, '/ud/config/secrets/redact-files.txt');
    assert.equal(p.window, '/ud/state/runtime/secret-window.json');
    assert.equal(p.log, '/ud/state/runtime/secret-log.jsonl');
  });
});

describe('assertNameAllowed', () => {
  it('refuses ANTHROPIC_API_KEY and CLAUDE_CREDIT_KEY_ROBIN; allows CLAUDE_API_KEY', () => {
    assert.throws(() => assertNameAllowed('ANTHROPIC_API_KEY'), /would enable paid credits/);
    assert.throws(() => assertNameAllowed('CLAUDE_CREDIT_KEY_ROBIN'), /would enable paid credits/);
    assert.doesNotThrow(() => assertNameAllowed('CLAUDE_API_KEY'));
    assert.throws(() => assertNameAllowed('lower-case'));
  });
  it('classifies secret-class names and default shape', () => {
    assert.ok(isSecretClassName('FOO_TOKEN'));
    assert.ok(!isSecretClassName('CHANNEL_ID'));
    assert.ok(defaultShape.test('spk_test_0123456789abcdef'));
    assert.ok(!defaultShape.test('short'));
  });
});

describe('setMaster', () => {
  it('returns unchanged for the same value, saved otherwise', () => {
    const d = tmpUserData();
    assert.equal(getMaster(d, 'FOO_KEY'), undefined);
    assert.equal(setMaster(d, 'FOO_KEY', 'spk_test_aaaaaaaaaaaaaaaa'), 'saved');
    assert.equal(setMaster(d, 'FOO_KEY', 'spk_test_aaaaaaaaaaaaaaaa'), 'unchanged');
    assert.equal(setMaster(d, 'FOO_KEY', 'spk_test_bbbbbbbbbbbbbbbb'), 'saved');
    assert.equal(getMaster(d, 'FOO_KEY'), 'spk_test_bbbbbbbbbbbbbbbb');
  });
});

describe('fingerprint', () => {
  it('last 4 + length', () => {
    assert.equal(fingerprint('spk_test_ZZZZ9f3c1e7a4b2d8c6e0f5a3b1d7c9e2f4a6b8'), '…a6b8 (48)');
  });
});

describe('findShadowing', () => {
  const base = {
    launchctlGetenv: () => undefined,
    daemonEnvPath: '/nonexistent',
    target: 'robin-env' as const,
  };
  it('shell env wins', () => {
    assert.equal(
      findShadowing('FOO_TOKEN', { ...base, env: { FOO_TOKEN: 'x' } }),
      'shell environment',
    );
  });
  it('launchctl environment', () => {
    assert.equal(
      findShadowing('FOO_TOKEN', { ...base, env: {}, launchctlGetenv: () => 'y' }),
      'launchctl environment',
    );
  });
  it('daemon.env only shadows robin-env targets', () => {
    const d = tmpUserData();
    const daemonEnvPath = secretsPaths(d).daemonEnv;
    writeFileSync(daemonEnvPath, 'FOO_TOKEN=zzz\n');
    const deps = { ...base, env: {}, daemonEnvPath };
    assert.equal(findShadowing('FOO_TOKEN', deps), 'daemon.env');
    assert.equal(findShadowing('FOO_TOKEN', { ...deps, target: 'env-local' }), null);
    assert.equal(findShadowing('OTHER_TOKEN', deps), null);
  });
});

describe('importRobinEnv', () => {
  it('copies secret-class ≥16 only; leaves .env byte-identical', () => {
    const d = tmpUserData();
    const p = secretsPaths(d);
    const text = 'FOO_TOKEN=abcdefghij0123456789\nCHANNEL_ID=123\nSHORT_KEY=abc\n';
    writeFileSync(p.robinEnv, text);
    assert.deepEqual(importRobinEnv(d), ['FOO_TOKEN']);
    assert.equal(readFileSync(p.robinEnv, 'utf8'), text);
    assert.equal(getMaster(d, 'FOO_TOKEN'), 'abcdefghij0123456789');
    assert.deepEqual(importRobinEnv(d), []);
  });
});

describe('appendLog', () => {
  it('line has no value field', () => {
    const d = tmpUserData();
    appendLog(d, {
      op: 'set',
      provider: 'acme',
      name: 'FOO_KEY',
      fingerprint: '…1234 (20)',
      session: 's1',
    });
    const line = JSON.parse(readFileSync(secretsPaths(d).log, 'utf8').trim());
    const allowed = new Set(['op', 'provider', 'name', 'fingerprint', 'session', 'ts']);
    for (const k of Object.keys(line)) assert.ok(allowed.has(k), k);
    assert.ok(line.ts);
  });
});

describe('launchctlGetenvWith', () => {
  it('runs /bin/launchctl by absolute path with a fixed env', () => {
    const calls: { file: string; args: string[]; env: unknown }[] = [];
    const get = launchctlGetenvWith((file, args, opts) => {
      calls.push({ file, args, env: opts.env });
      return 'value\n';
    });
    assert.equal(get('SOME_TEST_NAME'), 'value');
    assert.deepEqual(calls, [
      {
        file: '/bin/launchctl',
        args: ['getenv', 'SOME_TEST_NAME'],
        env: { PATH: '/usr/bin:/bin' },
      },
    ]);
    const empty = launchctlGetenvWith(() => '\n');
    assert.equal(empty('SOME_TEST_NAME'), undefined);
  });
});
