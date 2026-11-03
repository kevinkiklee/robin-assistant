import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { writeRole } from '../../lib/cloud/role.ts';

const cli = join(import.meta.dirname, 'index.ts');

test('robin daemon install refuses under mac-locked; help and -v still run', () => {
  const ud = mkdtempSync(join(tmpdir(), 'robin-cli-lock-'));
  writeRole(ud, { role: 'mac-locked', host: 'example-vm', at: '2026-11-02T00:00:00.000Z' });
  const env = { ...process.env, ROBIN_USER_DATA_DIR: ud };
  const r = spawnSync('pnpm', ['exec', 'tsx', cli, 'daemon', 'install'], { env, encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /This Mac's Robin is locked — Robin runs on example-vm/);
  const v = spawnSync('pnpm', ['exec', 'tsx', cli, '-v'], { env, encoding: 'utf8' });
  assert.equal(v.status, 0);
});
