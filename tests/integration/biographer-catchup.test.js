import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

function seedConfig(home) {
  writeFileSync(join(home, 'config.json'), JSON.stringify({ embedder_profile: 'mxbai-1024' }));
}

test('robin biographer-catchup runs without error against an empty DB', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'robin-catchup-'));
  seedConfig(tmp);
  const root = resolve(import.meta.dirname, '../..');
  // Migrate first
  spawnSync('node', [join(root, 'bin/robin'), 'migrate'], {
    env: { ...process.env, ROBIN_HOME: tmp },
    encoding: 'utf8',
  });
  // Run catchup with no events
  const result = spawnSync('node', [join(root, 'bin/robin'), 'biographer-catchup'], {
    env: { ...process.env, ROBIN_HOME: tmp, ROBIN_HOST: 'claude_code' },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
  assert.match(result.stdout, /processed 0 events/);
  rmSync(tmp, { recursive: true });
});

test('robin biographer-catchup --retry-failed reports nothing-to-retry on empty state', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'robin-catchup-rf-'));
  seedConfig(tmp);
  const root = resolve(import.meta.dirname, '../..');
  spawnSync('node', [join(root, 'bin/robin'), 'migrate'], {
    env: { ...process.env, ROBIN_HOME: tmp },
    encoding: 'utf8',
  });
  const result = spawnSync(
    'node',
    [join(root, 'bin/robin'), 'biographer-catchup', '--retry-failed'],
    {
      env: { ...process.env, ROBIN_HOME: tmp, ROBIN_HOST: 'claude_code' },
      encoding: 'utf8',
    },
  );
  assert.equal(result.status, 0, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
  assert.match(result.stdout, /processed 0 events|nothing to retry/);
  rmSync(tmp, { recursive: true });
});
