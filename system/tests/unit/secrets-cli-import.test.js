import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

test('secrets import --from <path>/runtime/secrets/.env succeeds', async () => {
  const v1 = join(tmpHome, 'v1');
  mkdirSync(join(v1, 'runtime', 'secrets'), { recursive: true });
  writeFileSync(join(v1, 'runtime', 'secrets', '.env'), 'KEY=value\n', 'utf-8');
  const { secretsImport } = await import(
    `../../runtime/cli/commands/secrets-import.js?cb=${Date.now()}`
  );
  await secretsImport(['--from', v1]);
  const dest = join(tmpHome, 'secrets', '.env');
  assert.ok(existsSync(dest));
  assert.match(readFileSync(dest, 'utf-8'), /KEY=value/);
});

test('secrets import accepts direct .env path', async () => {
  const src = join(tmpHome, 'custom.env');
  writeFileSync(src, 'KEY=value\n', 'utf-8');
  const { secretsImport } = await import(
    `../../runtime/cli/commands/secrets-import.js?cb=${Date.now()}`
  );
  await secretsImport(['--from', src]);
  const dest = join(tmpHome, 'secrets', '.env');
  assert.ok(existsSync(dest));
});
