import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadEnvFile } from './load-env.ts';

function freshUserData(): string {
  const dir = mkdtempSync(join(tmpdir(), 'robin-env-'));
  mkdirSync(join(dir, 'config', 'secrets'), { recursive: true });
  return dir;
}

test('loadEnvFile: missing file is a no-op', () => {
  const dir = mkdtempSync(join(tmpdir(), 'robin-env-empty-'));
  const env: NodeJS.ProcessEnv = {};
  const r = loadEnvFile(dir, env);
  assert.equal(r.loaded, 0);
  assert.equal(r.overwritten, 0);
  assert.deepEqual(env, {});
});

test('loadEnvFile: populates unset keys and skips comments + blanks', () => {
  const dir = freshUserData();
  writeFileSync(
    join(dir, 'config', 'secrets', '.env'),
    `# comment
DISCORD_BOT_TOKEN=secret123

DISCORD_APPLICATION_ID=app-id
`,
  );
  const env: NodeJS.ProcessEnv = {};
  const r = loadEnvFile(dir, env);
  assert.equal(r.loaded, 2);
  assert.equal(env.DISCORD_BOT_TOKEN, 'secret123');
  assert.equal(env.DISCORD_APPLICATION_ID, 'app-id');
});

test('loadEnvFile: existing process env wins over file', () => {
  const dir = freshUserData();
  writeFileSync(join(dir, 'config', 'secrets', '.env'), 'KEY=from-file\n');
  const env: NodeJS.ProcessEnv = { KEY: 'from-shell' };
  const r = loadEnvFile(dir, env);
  assert.equal(r.loaded, 0);
  assert.equal(r.overwritten, 1);
  assert.equal(env.KEY, 'from-shell');
});

test('loadEnvFile: handles quoted values and export prefix', () => {
  const dir = freshUserData();
  writeFileSync(
    join(dir, 'config', 'secrets', '.env'),
    `export QUOTED="value with spaces"
SINGLE='literal $no expand'
PLAIN=plain
`,
  );
  const env: NodeJS.ProcessEnv = {};
  loadEnvFile(dir, env);
  assert.equal(env.QUOTED, 'value with spaces');
  assert.equal(env.SINGLE, 'literal $no expand');
  assert.equal(env.PLAIN, 'plain');
});
