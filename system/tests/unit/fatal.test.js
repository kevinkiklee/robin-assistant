import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createFatalHandler } from '../../runtime/daemon/fatal.js';

async function tempLogDir() {
  return await mkdtemp(join(tmpdir(), 'robin-fatal-'));
}

test('writes a structured line to the log file', async () => {
  const dir = await tempLogDir();
  let exitCode = null;
  const handler = createFatalHandler({
    logDir: dir,
    shutdown: async () => {},
    exit: (code) => {
      exitCode = code;
    },
  });
  await handler(new Error('boom'));
  const log = await readFile(join(dir, 'fatal.log'), 'utf8');
  const lines = log.trim().split('\n');
  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.message, 'boom');
  assert.equal(typeof parsed.ts, 'string');
  assert.equal(typeof parsed.stack, 'string');
  assert.equal(exitCode, 1);
});

test('survives log-write failure and still exits', async () => {
  let exitCode = null;
  const handler = createFatalHandler({
    logDir: '/no/such/path/ever',
    shutdown: async () => {},
    exit: (code) => {
      exitCode = code;
    },
  });
  await handler(new Error('boom'));
  assert.equal(exitCode, 1);
});

test('forces exit even if shutdown hangs', async () => {
  const dir = await tempLogDir();
  let exitCode = null;
  const handler = createFatalHandler({
    logDir: dir,
    shutdown: () => new Promise(() => {}), // never resolves
    exit: (code) => {
      exitCode = code;
    },
    forceExitMs: 50,
  });
  // Don't await: the handler awaits the never-resolving shutdown.
  handler(new Error('boom'));
  // Wait for the force-exit timer to fire (50ms + a margin).
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(exitCode, 1);
});
