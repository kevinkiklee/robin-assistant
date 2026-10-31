import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { isProcessAlive, readPidfile, removePidfile, writePidfile } from './pidfile.ts';

function tmpPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'robin-pidfile-'));
  return join(dir, 'test.pid');
}

test('writePidfile creates the file with the given pid', () => {
  const p = tmpPath();
  writePidfile(p, 12345);
  assert.ok(existsSync(p));
  assert.equal(readPidfile(p), 12345);
});

test('writePidfile defaults to process.pid', () => {
  const p = tmpPath();
  writePidfile(p);
  assert.equal(readPidfile(p), process.pid);
});

test('readPidfile returns null for missing file', () => {
  assert.equal(readPidfile('/nonexistent/path/daemon.pid'), null);
});

test('readPidfile returns null for non-numeric content', () => {
  const p = tmpPath();
  writePidfile(p, 1);
  // Overwrite with junk
  writeFileSync(p, 'not-a-pid', 'utf8');
  assert.equal(readPidfile(p), null);
});

test('removePidfile deletes an existing file', () => {
  const p = tmpPath();
  writePidfile(p, 42);
  assert.ok(existsSync(p));
  removePidfile(p);
  assert.ok(!existsSync(p));
});

test('removePidfile is a no-op for missing file', () => {
  // Should not throw
  removePidfile('/nonexistent/path/daemon.pid');
});

test('isProcessAlive returns true for current process', () => {
  assert.ok(isProcessAlive(process.pid));
});

test('isProcessAlive returns false for a non-existent pid', () => {
  // Use a very large PID that almost certainly doesn't exist
  assert.equal(isProcessAlive(9999999), false);
});
