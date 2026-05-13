import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

function seedConfig(home) {
  mkdirSync(join(home, 'config'), { recursive: true });
  writeFileSync(join(home, 'config', 'config.json'), JSON.stringify({ embedder_profile: 'mxbai-1024' }));
}

test('robin migrate bootstraps ROBIN_HOME and applies the seed migrations', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'robin-bootstrap-'));
  seedConfig(tmp);
  const root = resolve(import.meta.dirname, '../../..');
  const result = spawnSync(process.execPath, [join(root, 'system/bin/robin'), 'migrate'], {
    env: { ...process.env, ROBIN_HOME: tmp },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  // Count is intentionally regex-matched, not pinned — every new migration
  // would otherwise tax this assertion. The currently-applied set is:
  // 0001..0007 + active 0008-embedder-<profile> + 0009-migrator-v1 +
  // 0010-safety-floor + 0011-jobs + 0012-action-trust + any newer ones.
  assert.match(result.stdout, /applied \d+ migrations/);
  assert.ok(existsSync(join(tmp, 'data', 'db')));
  assert.ok(existsSync(join(tmp, 'runtime', 'logs')));

  // Re-run is a no-op
  const result2 = spawnSync(process.execPath, [join(root, 'system/bin/robin'), 'migrate'], {
    env: { ...process.env, ROBIN_HOME: tmp },
    encoding: 'utf8',
  });
  assert.equal(result2.status, 0);
  assert.match(result2.stdout, /applied 0 migrations/);

  rmSync(tmp, { recursive: true });
});
