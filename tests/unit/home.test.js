import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ensureHome, paths } from '../../src/runtime/home.js';

test('ensureHome creates db, models, logs, backup dirs under ROBIN_HOME', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'robin-home-'));
  process.env.ROBIN_HOME = tmp;
  await ensureHome();
  const p = paths();
  assert.equal(p.home, tmp);
  assert.ok(existsSync(p.db));
  assert.ok(existsSync(p.models));
  assert.ok(existsSync(p.logs));
  assert.ok(existsSync(p.backup));
  rmSync(tmp, { recursive: true });
  Reflect.deleteProperty(process.env, 'ROBIN_HOME');
});

test('paths defaults to ~/.robin when ROBIN_HOME unset', () => {
  Reflect.deleteProperty(process.env, 'ROBIN_HOME');
  const p = paths();
  assert.match(p.home, /\.robin$/);
});
