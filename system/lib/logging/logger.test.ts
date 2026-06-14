import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { createLogger } from './logger.ts';

/** pino's file transport flushes asynchronously; poll for the expected content
 *  instead of a fixed sleep — a fixed 50ms loses the race under a loaded
 *  parallel suite run. Returns whatever was read at the deadline so the
 *  caller's asserts produce a useful diff on genuine failure. */
async function readLogWhenReady(file: string, ready: (text: string) => boolean): Promise<string> {
  const deadline = Date.now() + 5000;
  for (;;) {
    let text = '';
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      // not created yet
    }
    if (ready(text) || Date.now() > deadline) return text;
    await sleep(20);
  }
}

test('logger: writes structured JSON lines to file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'robin-log-'));
  const file = join(dir, 'daemon.log');
  const log = createLogger({ file, module: 'test' });
  log.info({ event: 'hello', val: 42 }, 'a test message');
  log.flush?.();
  const text = await readLogWhenReady(
    file,
    (t) => t.includes('a test message') && t.trim().endsWith('}'),
  );
  const lines = text.trim().split('\n');
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
  const text = await readLogWhenReady(file, (t) => t.includes('visible') && t.trim().endsWith('}'));
  assert.ok(!text.includes('sk-12345'), 'token leaked');
  assert.ok(!text.includes('AKIA-xxx'), 'api_key leaked');
  assert.ok(text.includes('[REDACTED]'));
  assert.ok(text.includes('visible'));
});
