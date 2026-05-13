import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

function seedConfig(home) {
  mkdirSync(join(home, 'config'), { recursive: true });
  writeFileSync(join(home, 'config', 'config.json'), JSON.stringify({ embedder_profile: 'mxbai-1024' }));
}

test('robin remember refuses without daemon (clear error)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'robin-rem-'));
  seedConfig(tmp);
  const root = resolve(import.meta.dirname, '../../..');
  const result = spawnSync(
    process.execPath,
    [join(root, 'system/bin/robin'), 'remember', 'hello world'],
    {
      env: { ...process.env, ROBIN_HOME: tmp },
      encoding: 'utf8',
    },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /daemon not running/);
  rmSync(tmp, { recursive: true });
});

test('robin remember without content prints usage', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'robin-rem-'));
  seedConfig(tmp);
  const root = resolve(import.meta.dirname, '../../..');
  const result = spawnSync(process.execPath, [join(root, 'system/bin/robin'), 'remember'], {
    env: { ...process.env, ROBIN_HOME: tmp },
    encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /usage: robin remember/);
  rmSync(tmp, { recursive: true });
});
