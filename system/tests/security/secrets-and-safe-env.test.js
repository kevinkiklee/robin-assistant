import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { requireSecret, getSecret, saveSecret, loadSecrets } from '../../scripts/sync/lib/secrets.js';
import { safeEnv, listSafeEnvKeys } from '../../scripts/lib/safe-env.js';

function ws() { return mkdtempSync(join(tmpdir(), 'secrets-')); }
function clean(p) { rmSync(p, { recursive: true, force: true }); }

function writeEnv(workspaceDir, content) {
  mkdirSync(join(workspaceDir, 'user-data/secrets'), { recursive: true });
  writeFileSync(join(workspaceDir, 'user-data/secrets/.env'), content);
}

test('requireSecret: reads value from .env file', () => {
  const w = ws();
  try {
    writeEnv(w, 'GITHUB_PAT=ghp_test\nDISCORD_BOT_TOKEN=tok\n');
    assert.equal(requireSecret(w, 'GITHUB_PAT'), 'ghp_test');
    assert.equal(requireSecret(w, 'DISCORD_BOT_TOKEN'), 'tok');
  } finally {
    clean(w);
  }
});

test('requireSecret: does NOT pollute process.env', () => {
  const w = ws();
  try {
    const beforeKey = 'TEST_NEVER_IN_ENV';
    delete process.env[beforeKey];
    writeEnv(w, `${beforeKey}=fromfile\n`);
    requireSecret(w, beforeKey);
    assert.equal(process.env[beforeKey], undefined,
      'process.env should NOT have been mutated');
  } finally {
    clean(w);
  }
});

test('requireSecret: throws on missing key', () => {
  const w = ws();
  try {
    writeEnv(w, 'OTHER=value\n');
    assert.throws(() => requireSecret(w, 'GITHUB_PAT'), /Missing secret: GITHUB_PAT/);
  } finally {
    clean(w);
  }
});

test('requireSecret: throws on missing workspaceDir', () => {
  assert.throws(() => requireSecret(null, 'KEY'), /workspaceDir and key are required/);
  assert.throws(() => requireSecret('', 'KEY'), /workspaceDir and key are required/);
});

test('requireSecret: throws on missing key arg', () => {
  assert.throws(() => requireSecret('/tmp', null), /workspaceDir and key are required/);
});

test('getSecret: returns null for missing key (does not throw)', () => {
  const w = ws();
  try {
    writeEnv(w, 'OTHER=value\n');
    assert.equal(getSecret(w, 'GITHUB_PAT'), null);
    assert.equal(getSecret(w, 'OTHER'), 'value');
  } finally {
    clean(w);
  }
});

test('saveSecret: writes mode 0600 + does NOT pollute process.env', () => {
  const w = ws();
  try {
    const beforeKey = 'TEST_SAVE_KEY';
    delete process.env[beforeKey];
    saveSecret(w, beforeKey, 'newvalue');
    assert.equal(process.env[beforeKey], undefined,
      'saveSecret no longer mutates process.env');
    // Verify the value is in the file and round-trips.
    assert.equal(requireSecret(w, beforeKey), 'newvalue');
  } finally {
    clean(w);
  }
});

test('loadSecrets: is a no-op (backwards compat shim) but requires workspaceDir', () => {
  assert.throws(() => loadSecrets(null), /workspaceDir is required/);
  assert.doesNotThrow(() => loadSecrets('/tmp'));
});

test('safeEnv: returns only allowlisted keys', () => {
  const orig = process.env.SECRET_LEAK_TEST_KEY;
  process.env.SECRET_LEAK_TEST_KEY = 'leaked';
  try {
    const env = safeEnv();
    assert.equal(env.SECRET_LEAK_TEST_KEY, undefined,
      'safeEnv should not include arbitrary process.env keys');
    if ('PATH' in process.env) {
      assert.equal(env.PATH, process.env.PATH, 'PATH should be passed through');
    }
  } finally {
    if (orig === undefined) delete process.env.SECRET_LEAK_TEST_KEY;
    else process.env.SECRET_LEAK_TEST_KEY = orig;
  }
});

test('safeEnv: extras parameter is merged in', () => {
  const env = safeEnv({ MY_DEBUG_FLAG: '1' });
  assert.equal(env.MY_DEBUG_FLAG, '1');
});

test('safeEnv: allowlist is non-empty and includes core vars', () => {
  const keys = listSafeEnvKeys();
  assert.ok(keys.length > 5);
  for (const must of ['HOME', 'PATH', 'USER']) {
    assert.ok(keys.includes(must), `safeEnv must include ${must}`);
  }
});

test('safeEnv: secret-shaped env keys are NOT in the allowlist', () => {
  const keys = listSafeEnvKeys();
  for (const forbidden of ['GITHUB_PAT', 'DISCORD_BOT_TOKEN', 'SPOTIFY_CLIENT_SECRET', 'GOOGLE_OAUTH_CLIENT_SECRET']) {
    assert.equal(keys.includes(forbidden), false, `${forbidden} must not be safeEnv-allowlisted`);
  }
});
