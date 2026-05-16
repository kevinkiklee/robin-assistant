import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import installUserDataWritable from '../../../runtime/invariants/install.user-data-writable.js';

const tmpRoot = join(tmpdir(), `robin-udw-${process.pid}-${Math.random().toString(36).slice(2)}`);
mkdirSync(tmpRoot, { recursive: true });
process.env.ROBIN_HOME = tmpRoot;

test('check passes when user-data is writable', async () => {
  const r = await installUserDataWritable.check();
  assert.equal(r.ok, true);
  assert.ok(r.evidence.dir);
});

test('explain produces markdown', () => {
  const md = installUserDataWritable.explain();
  assert.ok(md.includes('install.user_data_writable'));
});
