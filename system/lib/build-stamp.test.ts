import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { LOADED_DEEP_HASH, LOADED_SHA, readBuildStamp } from './build-stamp.ts';

function tmpRepoRoot(): string {
  return mkdtempSync(join(tmpdir(), 'robin-build-stamp-'));
}

function writeStamp(repoRoot: string, contents: string): void {
  mkdirSync(join(repoRoot, 'dist'), { recursive: true });
  writeFileSync(join(repoRoot, 'dist', '.build-stamp'), contents);
}

test('readBuildStamp: round-trips a well-formed stamp', () => {
  const repoRoot = tmpRepoRoot();
  writeStamp(repoRoot, 'abc1234\n2026-08-11T12:00:00.000Z\n');
  const stamp = readBuildStamp(repoRoot);
  assert.deepEqual(stamp, { sha: 'abc1234', at: '2026-08-11T12:00:00.000Z', deepHash: null });
});

test('readBuildStamp: accepts the "unknown" sha fallback (non-git checkout)', () => {
  const repoRoot = tmpRepoRoot();
  writeStamp(repoRoot, 'unknown\n2026-08-11T12:00:00.000Z\n');
  const stamp = readBuildStamp(repoRoot);
  assert.deepEqual(stamp, { sha: 'unknown', at: '2026-08-11T12:00:00.000Z', deepHash: null });
});

test('readBuildStamp: a third line is parsed as deepHash', () => {
  const repoRoot = tmpRepoRoot();
  writeStamp(repoRoot, 'abc1234\n2026-08-11T12:00:00.000Z\ndeadbeef00\n');
  const stamp = readBuildStamp(repoRoot);
  assert.deepEqual(stamp, {
    sha: 'abc1234',
    at: '2026-08-11T12:00:00.000Z',
    deepHash: 'deadbeef00',
  });
});

test('readBuildStamp: a 2-line legacy stamp (no trailing newline) → deepHash null', () => {
  const repoRoot = tmpRepoRoot();
  // No trailing '\n' after line 2 — split('\n') yields exactly 2 elements,
  // not a 3rd empty string. Both forms of "no third line" must parse the
  // same way for old stamps written before this field existed.
  writeStamp(repoRoot, 'abc1234\n2026-08-11T12:00:00.000Z');
  const stamp = readBuildStamp(repoRoot);
  assert.deepEqual(stamp, { sha: 'abc1234', at: '2026-08-11T12:00:00.000Z', deepHash: null });
});

test('readBuildStamp: missing file → null', () => {
  const repoRoot = tmpRepoRoot();
  // No dist/ dir at all — do NOT create it.
  assert.equal(readBuildStamp(repoRoot), null);
});

test('readBuildStamp: empty file → null', () => {
  const repoRoot = tmpRepoRoot();
  writeStamp(repoRoot, '');
  assert.equal(readBuildStamp(repoRoot), null);
});

test('readBuildStamp: missing second line (no build time) → null', () => {
  const repoRoot = tmpRepoRoot();
  writeStamp(repoRoot, 'abc1234\n');
  assert.equal(readBuildStamp(repoRoot), null);
});

test('readBuildStamp: unparseable build time → null', () => {
  const repoRoot = tmpRepoRoot();
  writeStamp(repoRoot, 'abc1234\nnot-a-date\n');
  assert.equal(readBuildStamp(repoRoot), null);
});

test('readBuildStamp: garbage binary content → null, never throws', () => {
  const repoRoot = tmpRepoRoot();
  mkdirSync(join(repoRoot, 'dist'), { recursive: true });
  writeFileSync(join(repoRoot, 'dist', '.build-stamp'), Buffer.from([0x00, 0xff, 0x10, 0x02]));
  assert.doesNotThrow(() => readBuildStamp(repoRoot));
  assert.equal(readBuildStamp(repoRoot), null);
});

test('readBuildStamp: unreadable repoRoot (nonexistent path) → null, never throws', () => {
  assert.doesNotThrow(() => readBuildStamp('/nonexistent/robin-build-stamp-path'));
  assert.equal(readBuildStamp('/nonexistent/robin-build-stamp-path'), null);
});

test('LOADED_SHA: captured at import time as a string or null, never throws on import', () => {
  assert.ok(LOADED_SHA === null || typeof LOADED_SHA === 'string');
});

test('LOADED_DEEP_HASH: captured at import time as a string or null, never throws on import', () => {
  assert.ok(LOADED_DEEP_HASH === null || typeof LOADED_DEEP_HASH === 'string');
});
