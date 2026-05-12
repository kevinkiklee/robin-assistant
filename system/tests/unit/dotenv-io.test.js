import assert from 'node:assert/strict';
import { mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

let tmpHome;
test.beforeEach(() => {
  tmpHome = join(tmpdir(), `robin-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpHome, { recursive: true });
  process.env.ROBIN_HOME = tmpHome;
});
test.afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

test('requireSecret throws on missing', async () => {
  const { requireSecret } = await import(`../../config/secrets.js?cb=${Date.now()}`);
  assert.throws(() => requireSecret('NOPE'), /missing secret/);
});

test('saveSecret + requireSecret round-trip', async () => {
  const { requireSecret, saveSecret } = await import(`../../config/secrets.js?cb=${Date.now()}`);
  saveSecret('FOO', 'bar');
  assert.equal(requireSecret('FOO'), 'bar');
});

test('saveSecret preserves siblings', async () => {
  const { requireSecret, saveSecret } = await import(`../../config/secrets.js?cb=${Date.now()}`);
  saveSecret('A', '1');
  saveSecret('B', '2');
  saveSecret('A', '11');
  assert.equal(requireSecret('A'), '11');
  assert.equal(requireSecret('B'), '2');
});

test('saveSecret produces 0600 file', async () => {
  const { saveSecret, envFilePath } = await import(`../../config/secrets.js?cb=${Date.now()}`);
  saveSecret('X', 'y');
  const mode = statSync(envFilePath()).mode & 0o777;
  assert.equal(mode, 0o600);
});

test('getSecret returns null on missing', async () => {
  const { getSecret } = await import(`../../config/secrets.js?cb=${Date.now()}`);
  assert.equal(getSecret('NOPE'), null);
});

test('importFrom copies file with 0600 perms', async () => {
  const { importFrom, requireSecret, envFilePath } = await import(
    `../../config/secrets.js?cb=${Date.now()}`
  );
  const src = join(tmpHome, 'src.env');
  writeFileSync(src, 'KEY=value\n', 'utf-8');
  importFrom(src);
  assert.equal(requireSecret('KEY'), 'value');
  const mode = statSync(envFilePath()).mode & 0o777;
  assert.equal(mode, 0o600);
});

test('importFrom refuses without --force when dest exists', async () => {
  const { importFrom, saveSecret } = await import(`../../config/secrets.js?cb=${Date.now()}`);
  saveSecret('EXISTING', 'yes');
  const src = join(tmpHome, 'src.env');
  writeFileSync(src, 'NEW=val\n', 'utf-8');
  assert.throws(() => importFrom(src), /already exists/);
});

test('importFrom with force overwrites', async () => {
  const { importFrom, saveSecret, requireSecret, getSecret } = await import(
    `../../config/secrets.js?cb=${Date.now()}`
  );
  saveSecret('OLD', 'v1');
  const src = join(tmpHome, 'src.env');
  writeFileSync(src, 'NEW=v2\n', 'utf-8');
  importFrom(src, { force: true });
  assert.equal(getSecret('OLD'), null);
  assert.equal(requireSecret('NEW'), 'v2');
});

test('parser ignores comments and malformed lines', async () => {
  const { importFrom, getSecret } = await import(`../../config/secrets.js?cb=${Date.now()}`);
  const src = join(tmpHome, 'src.env');
  writeFileSync(src, '# comment\n\nMALFORMED_NO_EQ\nGOOD=ok\n', 'utf-8');
  importFrom(src);
  assert.equal(getSecret('GOOD'), 'ok');
  assert.equal(getSecret('MALFORMED_NO_EQ'), null);
});

test('listKeys returns names only', async () => {
  const { saveSecret, listKeys } = await import(`../../config/secrets.js?cb=${Date.now()}`);
  saveSecret('A', '1');
  saveSecret('B', '2');
  const keys = listKeys();
  assert.deepEqual(keys.sort(), ['A', 'B']);
});

test('saveSecret rejects newline-bearing values (injection guard)', async () => {
  const { saveSecret, getSecret } = await import(`../../config/secrets.js?cb=${Date.now()}`);
  // Without the guard this would write two lines, silently introducing
  // INJECTED=evil into the secrets store.
  assert.throws(() => saveSecret('SAFE', 'value\nINJECTED=evil'), /must not contain newline/);
  assert.throws(() => saveSecret('SAFE', 'value\rINJECTED=evil'), /must not contain newline/);
  // Nothing should have landed on disk for SAFE or INJECTED.
  assert.equal(getSecret('SAFE'), null);
  assert.equal(getSecret('INJECTED'), null);
});

test('saveSecret rejects malformed keys', async () => {
  const { saveSecret } = await import(`../../config/secrets.js?cb=${Date.now()}`);
  // Empty, starts with digit, contains '=', contains whitespace, contains '\n'.
  assert.throws(() => saveSecret('', 'v'), /invalid secret key/);
  assert.throws(() => saveSecret('1BAD', 'v'), /invalid secret key/);
  assert.throws(() => saveSecret('A=B', 'v'), /invalid secret key/);
  assert.throws(() => saveSecret('A B', 'v'), /invalid secret key/);
  assert.throws(() => saveSecret('A\nB', 'v'), /invalid secret key/);
});

test('saveSecret rejects non-string values', async () => {
  const { saveSecret } = await import(`../../config/secrets.js?cb=${Date.now()}`);
  assert.throws(() => saveSecret('KEY', 42), /must be a string/);
  assert.throws(() => saveSecret('KEY', null), /must be a string/);
  assert.throws(() => saveSecret('KEY', undefined), /must be a string/);
});
