import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mock, test } from 'node:test';
import { authGoogle, parseCodeArg } from '../../src/cli/commands/auth-google.js';
import { requireSecret, saveSecret } from '../../src/secrets/dotenv-io.js';

let tmpHome;
test.beforeEach(() => {
  tmpHome = join(tmpdir(), `robin-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpHome, { recursive: true });
  process.env.ROBIN_HOME = tmpHome;
});
test.afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

function seedClientCreds() {
  saveSecret('GOOGLE_OAUTH_CLIENT_ID', 'cid');
  saveSecret('GOOGLE_OAUTH_CLIENT_SECRET', 'csec');
}

test('parseCodeArg detects loopback (no flag)', () => {
  assert.deepEqual(parseCodeArg([]), { mode: 'loopback' });
});

test('parseCodeArg detects --code alone (interactive)', () => {
  assert.deepEqual(parseCodeArg(['--code']), { mode: 'headless-interactive' });
});

test('parseCodeArg detects --code=<VALUE> (inline)', () => {
  assert.deepEqual(parseCodeArg(['--code=abc']), { mode: 'headless-inline', code: 'abc' });
});

test('parseCodeArg rejects space-separated --code <VALUE>', () => {
  const origExit = process.exit;
  let exitCode = 0;
  process.exit = (c) => {
    exitCode = c;
    throw new Error('exit');
  };
  try {
    assert.throws(() => parseCodeArg(['--code', 'something']));
    assert.equal(exitCode, 1);
  } finally {
    process.exit = origExit;
  }
});

test('auth google --code=<VALUE> exchanges and saves refresh_token', async () => {
  seedClientCreds();
  const restore = mock.method(globalThis, 'fetch', async () => ({
    ok: true,
    json: async () => ({ access_token: 'a', refresh_token: 'r-test', expires_in: 3600 }),
  }));
  try {
    await authGoogle(['--code=test-code']);
    assert.equal(requireSecret('GOOGLE_OAUTH_REFRESH_TOKEN'), 'r-test');
  } finally {
    restore.mock.restore();
  }
});

test('auth google --code <VALUE> (space) is rejected', async () => {
  seedClientCreds();
  const origExit = process.exit;
  let exitCode = 0;
  process.exit = (c) => {
    exitCode = c;
    throw new Error('exit');
  };
  try {
    await assert.rejects(() => authGoogle(['--code', 'something']));
    assert.equal(exitCode, 1);
  } finally {
    process.exit = origExit;
  }
});
