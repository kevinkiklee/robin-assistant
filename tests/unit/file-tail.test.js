import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readFileTail } from '../../src/runtime/file-tail.js';

function tmpFile(content) {
  const dir = join(tmpdir(), `robin-test-${process.pid}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'sample.jsonl');
  writeFileSync(path, content, 'utf8');
  return path;
}

test('readFileTail returns last N bytes', () => {
  const path = tmpFile('A'.repeat(100) + 'B'.repeat(50));
  assert.equal(readFileTail(path, 50), 'B'.repeat(50));
});

test('readFileTail returns whole file when smaller than maxBytes', () => {
  const path = tmpFile('hello');
  assert.equal(readFileTail(path, 100), 'hello');
});

test('readFileTail returns empty string on missing file', () => {
  assert.equal(readFileTail('/nonexistent/path.jsonl', 100), '');
});
