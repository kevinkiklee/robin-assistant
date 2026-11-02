import assert from 'node:assert';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { consumeShutdownStamp, writeShutdownStamp } from './shutdown-stamp.ts';

const stampPath = () => join(mkdtempSync(join(tmpdir(), 'stamp-')), 'shutdown-stamp.json');

test('write then consume returns the stamp and deletes the file', () => {
  const p = stampPath();
  writeShutdownStamp(p, 'shutdown', 4242);
  const s = consumeShutdownStamp(p);
  assert.ok(s);
  assert.strictEqual(s.pid, 4242);
  assert.strictEqual(s.reason, 'shutdown');
  assert.ok(Number.isFinite(Date.parse(s.at)));
  assert.strictEqual(existsSync(p), false); // single-use: consumed
  assert.strictEqual(consumeShutdownStamp(p), null); // second read finds nothing
});

test('consume of missing file returns null', () => {
  assert.strictEqual(consumeShutdownStamp(stampPath()), null);
});

test('consume of corrupt file returns null and deletes it', () => {
  const p = stampPath();
  writeFileSync(p, 'not json');
  assert.strictEqual(consumeShutdownStamp(p), null);
  assert.strictEqual(existsSync(p), false);
});

test('write defaults pid to process.pid and never throws on bad dir', () => {
  const p = stampPath();
  writeShutdownStamp(p, 'heartbeat-escalation');
  assert.strictEqual(consumeShutdownStamp(p)?.pid, process.pid);
  // Unwritable path must not throw (doctrine: visible-and-inert).
  writeShutdownStamp('/nonexistent-root-dir/x/stamp.json', 'shutdown');
});
