import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { createLogger } from './logger.ts';

test('logger: writes structured JSON lines to file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'robin-log-'));
  const file = join(dir, 'daemon.log');
  const log = createLogger({ file, module: 'test' });
  log.info({ event: 'hello', val: 42 }, 'a test message');
  log.flush?.();
  await sleep(50); // pino async flush
  const lines = readFileSync(file, 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.module, 'test');
  assert.equal(parsed.event, 'hello');
  assert.equal(parsed.val, 42);
  assert.equal(parsed.msg, 'a test message');
});

test('logger: redacts known secret-shaped fields', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'robin-log-'));
  const file = join(dir, 'daemon.log');
  const log = createLogger({ file, module: 'test' });
  log.info({ payload: { token: 'sk-12345', api_key: 'AKIA-xxx', value: 'visible' } }, 'sensitive');
  log.flush?.();
  await sleep(50);
  const text = readFileSync(file, 'utf8');
  assert.ok(!text.includes('sk-12345'), 'token leaked');
  assert.ok(!text.includes('AKIA-xxx'), 'api_key leaked');
  assert.ok(text.includes('[REDACTED]'));
  assert.ok(text.includes('visible'));
});
