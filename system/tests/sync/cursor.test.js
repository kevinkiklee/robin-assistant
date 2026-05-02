import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, rmSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadCursor, saveCursor, cursorPath } from '../../scripts/sync/lib/cursor.js';

function setup() {
  return mkdtempSync(join(tmpdir(), 'cursor-'));
}

test('loadCursor returns empty object when state file is missing', () => {
  const ws = setup();
  assert.deepEqual(loadCursor(ws, 'nope'), {});
  rmSync(ws, { recursive: true });
});

test('cursorPath is workspace + user-data/runtime/state/sync/<name>.json', () => {
  const ws = setup();
  assert.equal(cursorPath(ws, 'lunch-money'), join(ws, 'user-data/runtime/state/sync/lunch-money.json'));
  rmSync(ws, { recursive: true });
});

test('saveCursor + loadCursor roundtrip', () => {
  const ws = setup();
  saveCursor(ws, 'foo', { last_success_at: '2026-04-28T14:00:00Z', cursor: { offset: 100 } });
  const loaded = loadCursor(ws, 'foo');
  assert.equal(loaded.last_success_at, '2026-04-28T14:00:00Z');
  assert.deepEqual(loaded.cursor, { offset: 100 });
  rmSync(ws, { recursive: true });
});

test('saveCursor merges with existing state (does not drop fields)', () => {
  const ws = setup();
  saveCursor(ws, 'foo', { error_count: 0, cursor: { x: 1 } });
  saveCursor(ws, 'foo', { last_success_at: '2026-04-28T14:00:00Z' });
  const loaded = loadCursor(ws, 'foo');
  assert.equal(loaded.error_count, 0);
  assert.equal(loaded.last_success_at, '2026-04-28T14:00:00Z');
  assert.deepEqual(loaded.cursor, { x: 1 });
  rmSync(ws, { recursive: true });
});

test('saveCursor creates state dir if missing', () => {
  const ws = setup();
  saveCursor(ws, 'foo', { ok: true });
  assert.ok(existsSync(join(ws, 'user-data/runtime/state/sync')));
  rmSync(ws, { recursive: true });
});

test('saveCursor writes atomically (no .tmp left behind)', () => {
  const ws = setup();
  saveCursor(ws, 'foo', { ok: true });
  assert.ok(!existsSync(join(ws, 'user-data/runtime/state/sync/foo.json.tmp')));
  rmSync(ws, { recursive: true });
});

test('saveCursor formats JSON with 2-space indent + trailing newline', () => {
  const ws = setup();
  saveCursor(ws, 'foo', { a: 1 });
  const content = readFileSync(join(ws, 'user-data/runtime/state/sync/foo.json'), 'utf-8');
  assert.equal(content, '{\n  "a": 1\n}\n');
  rmSync(ws, { recursive: true });
});

test('loadCursor quarantines a corrupt state file and returns empty object', () => {
  const ws = setup();
  const dir = join(ws, 'user-data/runtime/state/sync');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'foo.json');
  writeFileSync(path, '{ this is not valid JSON');
  // suppress expected warning during test
  const origWarn = console.warn;
  console.warn = () => {};
  try {
    const loaded = loadCursor(ws, 'foo');
    assert.deepEqual(loaded, {});
  } finally {
    console.warn = origWarn;
  }
  // Original file is gone (renamed)
  assert.ok(!existsSync(path));
  // A quarantine file exists alongside it
  const siblings = readdirSync(dir);
  assert.ok(
    siblings.some((n) => n.startsWith('foo.json.corrupt-')),
    `expected a foo.json.corrupt-* file, got: ${siblings.join(', ')}`
  );
  rmSync(ws, { recursive: true });
});

test('saveCursor recovers from a corrupt prior state by quarantining and starting fresh', () => {
  const ws = setup();
  const dir = join(ws, 'user-data/runtime/state/sync');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'foo.json'), '{ corrupt');
  const origWarn = console.warn;
  console.warn = () => {};
  try {
    saveCursor(ws, 'foo', { fresh: true });
  } finally {
    console.warn = origWarn;
  }
  const loaded = loadCursor(ws, 'foo');
  assert.deepEqual(loaded, { fresh: true });
  rmSync(ws, { recursive: true });
});
