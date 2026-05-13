import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

function seedConfig(home) {
  mkdirSync(join(home, 'config'), { recursive: true });
  writeFileSync(
    join(home, 'config', 'config.json'),
    JSON.stringify({ embedder_profile: 'mxbai-1024' }),
  );
}

test('robin recall-eval --json exits 1 when rows_scored < min_rows', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'robin-cli-test-'));
  seedConfig(tmp);
  const root = resolve(import.meta.dirname, '../../..');
  // Migrate first to seed runtime:embedder + recall_eval thresholds
  const mig = spawnSync(process.execPath, [join(root, 'system/bin/robin'), 'migrate'], {
    env: { ...process.env, ROBIN_HOME: tmp },
    encoding: 'utf8',
  });
  assert.equal(mig.status, 0, `migrate failed: ${mig.stderr}`);

  const result = spawnSync(
    process.execPath,
    [join(root, 'system/bin/robin'), 'recall-eval', '--json', '--limit', '10'],
    { env: { ...process.env, ROBIN_HOME: tmp }, encoding: 'utf8' },
  );
  assert.equal(
    result.status,
    1,
    `expected exit 1, got ${result.status}. stdout: ${result.stdout} stderr: ${result.stderr}`,
  );
  const json = JSON.parse(result.stdout);
  assert.equal(json.rows_scored, 0);
  rmSync(tmp, { recursive: true });
});

test('robin recall-eval --replay --profile=<inactive> exits 3 with active profile in stderr', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'robin-cli-profile-'));
  seedConfig(tmp);
  const root = resolve(import.meta.dirname, '../../..');
  const mig = spawnSync(process.execPath, [join(root, 'system/bin/robin'), 'migrate'], {
    env: { ...process.env, ROBIN_HOME: tmp },
    encoding: 'utf8',
  });
  assert.equal(mig.status, 0, `migrate failed: ${mig.stderr}`);

  const result = spawnSync(
    process.execPath,
    [
      join(root, 'system/bin/robin'),
      'recall-eval',
      '--replay',
      '--profile=nonexistent',
      '--json',
      '--limit',
      '10',
    ],
    { env: { ...process.env, ROBIN_HOME: tmp }, encoding: 'utf8' },
  );
  assert.equal(result.status, 3, `expected exit 3, got ${result.status}. stderr: ${result.stderr}`);
  assert.ok(
    result.stderr.includes('mxbai-1024'),
    `stderr should mention active profile 'mxbai-1024'; got: ${result.stderr}`,
  );
  rmSync(tmp, { recursive: true });
});
