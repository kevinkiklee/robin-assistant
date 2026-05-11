import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
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

test('write fake v1 .env, run import, requireSecret reads keys', async () => {
  const v1 = join(tmpHome, 'v1');
  mkdirSync(join(v1, 'runtime', 'secrets'), { recursive: true });
  writeFileSync(
    join(v1, 'runtime', 'secrets', '.env'),
    'GMAIL_TOKEN=abc\nGITHUB_PAT=ghp_xyz\n',
    'utf-8',
  );
  const { secretsImport } = await import(
    `../../src/cli/commands/secrets-import.js?cb=${Date.now()}`
  );
  await secretsImport(['--from', v1]);
  const { requireSecret } = await import(`../../src/secrets/dotenv-io.js?cb=${Date.now()}`);
  assert.equal(requireSecret('GMAIL_TOKEN'), 'abc');
  assert.equal(requireSecret('GITHUB_PAT'), 'ghp_xyz');
});

test('import accepts direct .env path', async () => {
  const src = join(tmpHome, 'custom.env');
  writeFileSync(src, 'KEY=value\n', 'utf-8');
  const { secretsImport } = await import(
    `../../src/cli/commands/secrets-import.js?cb=${Date.now()}`
  );
  await secretsImport(['--from', src]);
  const { requireSecret } = await import(`../../src/secrets/dotenv-io.js?cb=${Date.now()}`);
  assert.equal(requireSecret('KEY'), 'value');
});
