import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { closeDb, openDb, type RobinDb } from '../../brain/memory/db.ts';
import { clearShadowingTokenRows, resolveRedirect, upsertEnvKey } from './reauth.ts';

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

test('resolveRedirect: falls back to localhost + preset path + default port', () => {
  const r = resolveRedirect(undefined, undefined, { callbackPath: '/callback' });
  assert.equal(r.redirectUri, 'http://localhost:8089/callback');
  assert.equal(r.port, 8089);
  assert.equal(r.callbackPath, '/callback');
});

test('resolveRedirect: honors the --port flag when no override', () => {
  const r = resolveRedirect(undefined, 9000, { callbackPath: '/oauth/callback' });
  assert.equal(r.redirectUri, 'http://localhost:9000/oauth/callback');
  assert.equal(r.port, 9000);
  assert.equal(r.callbackPath, '/oauth/callback');
});

test('resolveRedirect: override wins and drives port + path verbatim', () => {
  // A registered redirect on a different port AND path — both must be honored,
  // and the override URI is used exactly (it must byte-match the registration).
  const r = resolveRedirect('http://localhost:1234/whoop/cb', 8089, {
    callbackPath: '/callback',
  });
  assert.equal(r.redirectUri, 'http://localhost:1234/whoop/cb');
  assert.equal(r.port, 1234);
  assert.equal(r.callbackPath, '/whoop/cb');
});

function freshDb(): RobinDb {
  const dir = mkdtempSync(join(tmpdir(), 'robin-reauth-db-'));
  const db = openDb(join(dir, 'robin.sqlite'));
  db.exec(
    `CREATE TABLE integration_state (
       integration_name TEXT NOT NULL,
       key TEXT NOT NULL,
       value TEXT,
       updated_at TEXT,
       PRIMARY KEY (integration_name, key)
     )`,
  );
  return db;
}

function seedWhoop(db: RobinDb): void {
  const rows: Array<[string, string, string]> = [
    ['whoop', 'whoop_refresh_token', 'dead-rotated-token'],
    ['whoop', 'whoop_access_token', 'cached-access'],
    ['whoop', 'whoop_access_token_expiry', '1753000000000'],
    ['whoop', 'cursor_recovery', '2026-07-20T20:00:16Z'],
    ['whoop', 'last_sync', '2026-07-20T20:00:16Z'],
    ['whoop', 'consecutive_errors', '1'],
    // A different integration that must be left untouched.
    ['gmail', 'google_access_token', 'gmail-cached'],
  ];
  const stmt = db.prepare(
    'INSERT INTO integration_state (integration_name, key, value) VALUES (?, ?, ?)',
  );
  for (const [name, key, value] of rows) stmt.run(name, key, value);
}

function keysFor(db: RobinDb, integrationName: string): string[] {
  return (
    db
      .prepare('SELECT key FROM integration_state WHERE integration_name = ? ORDER BY key')
      .all(integrationName) as Array<{ key: string }>
  ).map((r) => r.key);
}

test('clearShadowingTokenRows: deletes only the cached token rows', () => {
  const db = freshDb();
  try {
    seedWhoop(db);
    const deleted = clearShadowingTokenRows(db, 'whoop');
    assert.equal(deleted, 3, 'refresh_token + access_token + access_token_expiry');
    // Cursors, last_sync, and the error counter survive — only tokens are cleared.
    assert.deepEqual(keysFor(db, 'whoop'), ['consecutive_errors', 'cursor_recovery', 'last_sync']);
  } finally {
    closeDb(db);
  }
});

test('clearShadowingTokenRows: is scoped to the named integration', () => {
  const db = freshDb();
  try {
    seedWhoop(db);
    clearShadowingTokenRows(db, 'whoop');
    // gmail's cached token must be untouched — reauth of one provider must not
    // clear another's state.
    assert.deepEqual(keysFor(db, 'gmail'), ['google_access_token']);
  } finally {
    closeDb(db);
  }
});

test('clearShadowingTokenRows: no matching rows returns 0', () => {
  const db = freshDb();
  try {
    const deleted = clearShadowingTokenRows(db, 'whoop');
    assert.equal(deleted, 0);
  } finally {
    closeDb(db);
  }
});
