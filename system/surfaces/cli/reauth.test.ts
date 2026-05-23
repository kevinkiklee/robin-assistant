import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { upsertEnvKey } from './reauth.ts';

function freshEnv(initial = ''): string {
  const dir = mkdtempSync(join(tmpdir(), 'robin-reauth-env-'));
  const path = join(dir, '.env');
  writeFileSync(path, initial, 'utf8');
  return path;
}

test('upsertEnvKey: replaces an existing key in place', () => {
  const path = freshEnv(
    [
      '# comment line stays',
      'GMAIL_CLIENT_ID=cid',
      'GMAIL_REFRESH_TOKEN=old-token-here',
      'GMAIL_CLIENT_SECRET=csec',
      '',
    ].join('\n'),
  );
  upsertEnvKey(path, 'GMAIL_REFRESH_TOKEN', 'new-token-12345');
  const out = readFileSync(path, 'utf8');
  assert.match(out, /GMAIL_REFRESH_TOKEN=new-token-12345/);
  assert.equal(out.match(/GMAIL_REFRESH_TOKEN=/g)?.length, 1, 'no duplicate keys');
  assert.match(out, /# comment line stays/);
  assert.match(out, /GMAIL_CLIENT_ID=cid/);
  assert.match(out, /GMAIL_CLIENT_SECRET=csec/);
});

test('upsertEnvKey: appends when the key is absent', () => {
  const path = freshEnv('FOO=bar\n');
  upsertEnvKey(path, 'BAZ', 'qux');
  const out = readFileSync(path, 'utf8');
  assert.match(out, /FOO=bar/);
  assert.match(out, /BAZ=qux/);
});

test('upsertEnvKey: respects export-prefixed lines', () => {
  const path = freshEnv('export GMAIL_REFRESH_TOKEN=stale\n');
  upsertEnvKey(path, 'GMAIL_REFRESH_TOKEN', 'fresh');
  const out = readFileSync(path, 'utf8');
  // We don't preserve the `export ` prefix, but we must replace the line, not
  // append a duplicate.
  assert.equal(out.match(/GMAIL_REFRESH_TOKEN=/g)?.length, 1);
  assert.match(out, /GMAIL_REFRESH_TOKEN=fresh/);
});

test('upsertEnvKey: only quotes values that need it', () => {
  const path = freshEnv('');
  upsertEnvKey(path, 'SAFE', 'abc123-_.~/');
  upsertEnvKey(path, 'WHITESPACEY', 'has spaces');
  const out = readFileSync(path, 'utf8');
  assert.match(out, /^SAFE=abc123-_\.~\/$/m);
  assert.match(out, /^WHITESPACEY="has spaces"$/m);
});

test('upsertEnvKey: creates file if missing-but-parent-exists case is OK', () => {
  // We only set up `existsSync` fallthrough; the parent dir must exist already
  // (the CLI guarantees this via paths.ts). This test just confirms an empty
  // initial file is handled.
  const path = freshEnv('');
  upsertEnvKey(path, 'X', '1');
  assert.match(readFileSync(path, 'utf8'), /X=1/);
});
