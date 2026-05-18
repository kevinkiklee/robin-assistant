import { strict as assert } from 'node:assert';
import {
  mkdirSync as __robinMkdirSync,
  writeFileSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { tmpdir as __robinTmpdir } from 'node:os';
import { join as __robinJoin } from 'node:path';
import test from 'node:test';

const __robinTestHome = __robinJoin(
  __robinTmpdir(),
  `robin-test-mcp-token-${process.pid}-${Math.random().toString(36).slice(2)}`,
);
__robinMkdirSync(__robinTestHome, { recursive: true });
process.env.ROBIN_HOME = __robinTestHome;

const { ensureMcpToken, readMcpToken } = await import('../../config/mcp-token.js');
const { paths } = await import('../../config/data-store.js');

test('ensureMcpToken mints a 64-hex-char token when none exists', () => {
  const token = ensureMcpToken();
  assert.match(token, /^[0-9a-f]{64}$/);
});

test('ensureMcpToken is idempotent — same token on repeat calls', () => {
  const a = ensureMcpToken();
  const b = ensureMcpToken();
  assert.equal(a, b);
});

test('readMcpToken returns the persisted token', () => {
  const token = ensureMcpToken();
  assert.equal(readMcpToken(), token);
});

test('token file is mode 0600', () => {
  ensureMcpToken();
  const st = statSync(paths.data.mcpToken());
  // Lower 9 bits = perm; mask 0o777.
  assert.equal(st.mode & 0o777, 0o600);
});

test('corrupted token file → re-mint, not silent accept', () => {
  writeFileSync(paths.data.mcpToken(), 'not-hex-and-too-short', { mode: 0o600 });
  assert.equal(readMcpToken(), null); // corruption surfaced
  const fresh = ensureMcpToken();
  assert.match(fresh, /^[0-9a-f]{64}$/);
  // And the corrupted content is gone — readMcpToken now returns the fresh one.
  assert.equal(readFileSync(paths.data.mcpToken(), 'utf8').trim(), fresh);
});
