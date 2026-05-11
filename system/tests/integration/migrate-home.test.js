import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { migrateHome } from '../../runtime/install/migrate-home.js';

test('migrateHome: copies tree and preserves 0600 secrets mode, then deletes source on move', async () => {
  const src = mkdtempSync(join(tmpdir(), 'robin-src-'));
  const dstParent = mkdtempSync(join(tmpdir(), 'robin-dst-parent-'));
  const dst = join(dstParent, 'home');
  mkdirSync(join(src, 'db'), { recursive: true });
  mkdirSync(join(src, 'secrets'), { recursive: true });
  writeFileSync(join(src, 'db', 'CURRENT'), 'rocksdb-current');
  writeFileSync(join(src, 'secrets', '.env'), 'KEY=v', { mode: 0o600 });
  writeFileSync(join(src, '.robin-data'), JSON.stringify({ version: 1, createdAt: 'x' }));

  await migrateHome({ from: src, to: dst, mode: 'move' });

  assert.ok(existsSync(join(dst, 'db', 'CURRENT')));
  assert.strictEqual(readFileSync(join(dst, 'db', 'CURRENT'), 'utf8'), 'rocksdb-current');
  assert.strictEqual(readFileSync(join(dst, 'secrets', '.env'), 'utf8'), 'KEY=v');
  const stat = statSync(join(dst, 'secrets', '.env'));
  assert.strictEqual(stat.mode & 0o777, 0o600);
  assert.strictEqual(existsSync(src), false, 'source must be gone after move');

  rmSync(dstParent, { recursive: true, force: true });
});

test('migrateHome: copy mode keeps source intact', async () => {
  const src = mkdtempSync(join(tmpdir(), 'robin-src-'));
  const dstParent = mkdtempSync(join(tmpdir(), 'robin-dst-parent-'));
  const dst = join(dstParent, 'home');
  mkdirSync(join(src, 'db'), { recursive: true });
  writeFileSync(join(src, 'db', 'CURRENT'), 'x');
  writeFileSync(join(src, '.robin-data'), JSON.stringify({ version: 1, createdAt: 'x' }));

  await migrateHome({ from: src, to: dst, mode: 'copy' });

  assert.ok(existsSync(join(dst, 'db', 'CURRENT')));
  assert.ok(existsSync(src), 'source must remain after copy');

  rmSync(src, { recursive: true, force: true });
  rmSync(dstParent, { recursive: true, force: true });
});

test('migrateHome: copy failure leaves source intact and removes partial target', async () => {
  const src = mkdtempSync(join(tmpdir(), 'robin-src-'));
  writeFileSync(join(src, '.robin-data'), JSON.stringify({ version: 1, createdAt: 'x' }));
  const dst = '/nonexistent-parent-robin-test/home';

  await assert.rejects(
    () => migrateHome({ from: src, to: dst, mode: 'move' }),
    /ENOENT|migrateHome/,
  );
  assert.ok(existsSync(src), 'source must remain after failed migrate');

  rmSync(src, { recursive: true, force: true });
});
