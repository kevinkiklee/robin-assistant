import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

// Set ROBIN_HOME to a temp dir before importing the job module so
// paths.data.logs() resolves correctly in every test.
const __h = join(
  tmpdir(),
  `robin-log-rotate-${process.pid}-${Math.random().toString(36).slice(2)}`,
);
mkdirSync(join(__h, 'cache', 'logs'), { recursive: true });
process.env.ROBIN_HOME = __h;

const { default: logRotate } = await import('../../cognition/jobs/internal/log-rotate.js');

const LOGS_DIR = join(__h, 'cache', 'logs');
const DAEMON_LOG = join(LOGS_DIR, 'daemon.log');
const ARCHIVE = join(LOGS_DIR, 'daemon.log.1');

const THRESHOLD = 10 * 1024 * 1024; // 10 MB default

function writeLog(path, sizeBytes) {
  writeFileSync(path, Buffer.alloc(sizeBytes, 'x'));
}

test('no-op when daemon.log does not exist', async () => {
  // Ensure no log file is present.
  try {
    await import('node:fs').then(({ rmSync }) => rmSync(DAEMON_LOG, { force: true }));
  } catch {}

  const result = JSON.parse(await logRotate());
  assert.equal(result.rotated, false);
  assert.equal(result.reason, 'no_log_file');
});

test('no-op when log is below threshold', async () => {
  const small = THRESHOLD - 1;
  writeLog(DAEMON_LOG, small);

  const result = JSON.parse(await logRotate());
  assert.equal(result.rotated, false);
  assert.equal(result.sizeBytes, small);
  assert.equal(result.threshold, THRESHOLD);
  // File must be untouched.
  assert.equal(statSync(DAEMON_LOG).size, small);
});

test('rotates when log meets threshold — original truncated to 0 bytes', async () => {
  const content = 'hello from daemon\n'.repeat(100);
  writeFileSync(DAEMON_LOG, content);
  // Override threshold so we don't have to write 10 MB in a unit test.
  writeFileSync(
    join(__h, 'config.json'),
    JSON.stringify({ logs: { rotateAtBytes: content.length } }),
  );

  const result = JSON.parse(await logRotate());
  assert.equal(result.rotated, true);
  assert.equal(result.sizeBytes, content.length);
  assert.equal(result.threshold, content.length);

  // Archive must contain the original content.
  assert.equal(readFileSync(ARCHIVE, 'utf8'), content);
  // Original must be truncated (inode preserved, size = 0).
  assert.equal(statSync(DAEMON_LOG).size, 0);
});

test('overwrites existing daemon.log.1 on rotation', async () => {
  const oldArchive = 'stale archive content';
  const newContent = 'fresh daemon output\n'.repeat(50);
  const threshold = newContent.length;

  writeFileSync(ARCHIVE, oldArchive);
  writeFileSync(DAEMON_LOG, newContent);
  writeFileSync(join(__h, 'config.json'), JSON.stringify({ logs: { rotateAtBytes: threshold } }));

  const result = JSON.parse(await logRotate());
  assert.equal(result.rotated, true);

  // .1 must reflect the new content, not the old stale archive.
  assert.equal(readFileSync(ARCHIVE, 'utf8'), newContent);
  assert.equal(statSync(DAEMON_LOG).size, 0);
});

test('uses config.json logs.rotateAtBytes threshold when present', async () => {
  const customThreshold = 512;
  writeLog(DAEMON_LOG, customThreshold);
  writeFileSync(
    join(__h, 'config.json'),
    JSON.stringify({ logs: { rotateAtBytes: customThreshold } }),
  );

  const result = JSON.parse(await logRotate());
  assert.equal(result.rotated, true);
  assert.equal(result.threshold, customThreshold);
});

test('no rotation when log is one byte below custom threshold', async () => {
  const customThreshold = 256;
  writeLog(DAEMON_LOG, customThreshold - 1);
  writeFileSync(
    join(__h, 'config.json'),
    JSON.stringify({ logs: { rotateAtBytes: customThreshold } }),
  );

  const result = JSON.parse(await logRotate());
  assert.equal(result.rotated, false);
  assert.equal(result.sizeBytes, customThreshold - 1);
});
