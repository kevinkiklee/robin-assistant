import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { closeDb, openDb, type RobinDb, registerDbGuard, registerDbInit } from './db.ts';

test('registerDbGuard: a throwing guard aborts before anything is created', () => {
  const root = mkdtempSync(join(tmpdir(), 'robin-guard-'));
  const target = join(root, 'forbidden', 'state', 'robin.sqlite');
  const off = registerDbGuard((p) => {
    if (p.includes('forbidden')) throw new Error('guard: forbidden path');
  });
  try {
    assert.throws(() => openDb(target), /guard: forbidden path/);
    assert.equal(existsSync(join(root, 'forbidden')), false, 'guard must run before mkdirSync');
  } finally {
    off();
  }
  const db = openDb(target); // unregistered → opens fine
  db.close();
});

test('registerDbInit: runs on every connection; unregister stops it', () => {
  const root = mkdtempSync(join(tmpdir(), 'robin-init-'));
  const seen: string[] = [];
  const off = registerDbInit((db) => seen.push(db.name));
  const a = openDb(join(root, 'a.sqlite'));
  const b = openDb(join(root, 'b.sqlite'));
  off();
  const c = openDb(join(root, 'c.sqlite'));
  for (const d of [a, b, c]) d.close();
  assert.deepEqual(
    seen.map((s) => s.split('/').pop()),
    ['a.sqlite', 'b.sqlite'],
  );
});

// Every connection the memory pipeline opens must go through openDb so lab hooks
// (sim clock, path guard) apply. Files outside the pipeline that legitimately
// open raw connections are allowlisted.
const RAW_ALLOWED = new Set([
  'brain/memory/db.ts',
  'lib/sql-clock.ts',
  'surfaces/cli/db.ts',
  'integrations/builtin/_chrome/index.ts',
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.ts') && !p.endsWith('.test.ts')) out.push(p);
  }
  return out;
}

test('no raw `new Database(` outside the allowlist', () => {
  const systemDir = join(import.meta.dirname, '..', '..');
  const offenders = walk(systemDir)
    .filter((p) => readFileSync(p, 'utf8').includes('new Database('))
    .map((p) => relative(systemDir, p))
    .filter((p) => !RAW_ALLOWED.has(p) && !p.startsWith('tests/'));
  assert.deepEqual(offenders, []);
});

test('openDb: an init hook that throws closes the connection and rethrows', () => {
  const dir = mkdtempSync(join(tmpdir(), 'robin-dbinit-'));
  let opened: RobinDb | null = null;
  const off1 = registerDbInit((db) => {
    opened = db;
  });
  const off2 = registerDbInit(() => {
    throw new Error('init boom');
  });
  try {
    assert.throws(() => openDb(join(dir, 'x.sqlite')), /init boom/);
    assert.equal((opened as unknown as RobinDb).open, false);
  } finally {
    off1();
    off2();
  }
});

test('openDb: a hook that unregisters itself mid-loop does not skip the next hook', () => {
  const dir = mkdtempSync(join(tmpdir(), 'robin-dbinit-'));
  const seen: string[] = [];
  const offA = registerDbInit(() => {
    seen.push('a');
    offA();
  });
  const offB = registerDbInit(() => seen.push('b'));
  try {
    closeDb(openDb(join(dir, 'y.sqlite')));
    assert.deepEqual(seen, ['a', 'b']);
  } finally {
    offB();
  }
});
