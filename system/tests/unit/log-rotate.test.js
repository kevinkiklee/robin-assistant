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
mkdirSync(join(__h, 'runtime', 'logs'), { recursive: true });
mkdirSync(join(__h, 'config'), { recursive: true });
process.env.ROBIN_HOME = __h;

const { default: logRotate } = await import('../../cognition/jobs/internal/log-rotate.js');

const LOGS_DIR = join(__h, 'runtime', 'logs');
const DAEMON_LOG = join(LOGS_DIR, 'daemon.log');
const ARCHIVE = join(LOGS_DIR, 'daemon.log.1');
const BIOGRAPHER_LOG = join(LOGS_DIR, 'biographer.log');
const BIOGRAPHER_ARCHIVE = join(LOGS_DIR, 'biographer.log.1');
const CONFIG_PATH = join(__h, 'config', 'config.json');

const THRESHOLD = 10 * 1024 * 1024; // 10 MB default

function writeLog(path, sizeBytes) {
  writeFileSync(path, Buffer.alloc(sizeBytes, 'x'));
}

async function clean(path) {
  await import('node:fs').then(({ rmSync }) => rmSync(path, { force: true }));
}

test('no-op when daemon.log does not exist', async () => {
  await clean(DAEMON_LOG);
  await clean(BIOGRAPHER_LOG);
  const result = JSON.parse(await logRotate());
  assert.equal(result['daemon.log'].rotated, false);
  assert.equal(result['daemon.log'].reason, 'no_log_file');
  assert.equal(result['biographer.log'].rotated, false);
  assert.equal(result['biographer.log'].reason, 'no_log_file');
});

test('no-op when log is below threshold', async () => {
  const small = THRESHOLD - 1;
  writeLog(DAEMON_LOG, small);
  await clean(CONFIG_PATH);

  const result = JSON.parse(await logRotate());
  assert.equal(result['daemon.log'].rotated, false);
  assert.equal(result['daemon.log'].sizeBytes, small);
  assert.equal(result['daemon.log'].threshold, THRESHOLD);
  assert.equal(statSync(DAEMON_LOG).size, small);
});

test('rotates when log meets threshold — original truncated to 0 bytes', async () => {
  const content = 'hello from daemon\n'.repeat(100);
  writeFileSync(DAEMON_LOG, content);
  writeFileSync(CONFIG_PATH, JSON.stringify({ logs: { rotateAtBytes: content.length } }));

  const result = JSON.parse(await logRotate());
  assert.equal(result['daemon.log'].rotated, true);
  assert.equal(result['daemon.log'].sizeBytes, content.length);
  assert.equal(result['daemon.log'].threshold, content.length);

  assert.equal(readFileSync(ARCHIVE, 'utf8'), content);
  assert.equal(statSync(DAEMON_LOG).size, 0);
});

test('overwrites existing daemon.log.1 on rotation', async () => {
  const oldArchive = 'stale archive content';
  const newContent = 'fresh daemon output\n'.repeat(50);
  const threshold = newContent.length;

  writeFileSync(ARCHIVE, oldArchive);
  writeFileSync(DAEMON_LOG, newContent);
  writeFileSync(CONFIG_PATH, JSON.stringify({ logs: { rotateAtBytes: threshold } }));

  const result = JSON.parse(await logRotate());
  assert.equal(result['daemon.log'].rotated, true);

  assert.equal(readFileSync(ARCHIVE, 'utf8'), newContent);
  assert.equal(statSync(DAEMON_LOG).size, 0);
});

test('uses config.json logs.rotateAtBytes threshold when present', async () => {
  const customThreshold = 512;
  writeLog(DAEMON_LOG, customThreshold);
  writeFileSync(CONFIG_PATH, JSON.stringify({ logs: { rotateAtBytes: customThreshold } }));

  const result = JSON.parse(await logRotate());
  assert.equal(result['daemon.log'].rotated, true);
  assert.equal(result['daemon.log'].threshold, customThreshold);
});

test('no rotation when log is one byte below custom threshold', async () => {
  const customThreshold = 256;
  await clean(DAEMON_LOG);
  await clean(BIOGRAPHER_LOG);
  writeLog(DAEMON_LOG, customThreshold - 1);
  writeFileSync(CONFIG_PATH, JSON.stringify({ logs: { rotateAtBytes: customThreshold } }));

  const result = JSON.parse(await logRotate());
  assert.equal(result['daemon.log'].rotated, false);
  assert.equal(result['daemon.log'].sizeBytes, customThreshold - 1);
});

test('rotates biographer.log alongside daemon.log when both exceed threshold', async () => {
  const customThreshold = 1024;
  // Both logs over threshold.
  writeLog(DAEMON_LOG, customThreshold + 100);
  writeLog(BIOGRAPHER_LOG, customThreshold + 200);
  writeFileSync(CONFIG_PATH, JSON.stringify({ logs: { rotateAtBytes: customThreshold } }));

  const result = JSON.parse(await logRotate());
  assert.equal(result['daemon.log'].rotated, true);
  assert.equal(result['biographer.log'].rotated, true);
  assert.equal(statSync(DAEMON_LOG).size, 0);
  assert.equal(statSync(BIOGRAPHER_LOG).size, 0);
  assert.equal(statSync(ARCHIVE).size, customThreshold + 100);
  assert.equal(statSync(BIOGRAPHER_ARCHIVE).size, customThreshold + 200);
});

test('rotates biographer.log independently when daemon.log is below threshold', async () => {
  const customThreshold = 512;
  await clean(DAEMON_LOG);
  writeLog(BIOGRAPHER_LOG, customThreshold + 50);
  writeFileSync(CONFIG_PATH, JSON.stringify({ logs: { rotateAtBytes: customThreshold } }));

  const result = JSON.parse(await logRotate());
  assert.equal(result['daemon.log'].rotated, false);
  assert.equal(result['daemon.log'].reason, 'no_log_file');
  assert.equal(result['biographer.log'].rotated, true);
  assert.equal(statSync(BIOGRAPHER_LOG).size, 0);
});
