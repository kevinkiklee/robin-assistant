import assert from 'node:assert';
import test from 'node:test';
import { log, setSink } from '../../runtime/log/index.js';

test('log.info emits structured JSON with event + fields', () => {
  const lines = [];
  setSink((line) => lines.push(line));
  log.info({ event: 'test.ok', count: 42, name: 'kevin' });
  setSink(null); // restore default
  assert.strictEqual(lines.length, 1);
  const parsed = JSON.parse(lines[0]);
  assert.strictEqual(parsed.event, 'test.ok');
  assert.strictEqual(parsed.level, 'info');
  assert.strictEqual(parsed.count, 42);
  assert.strictEqual(parsed.name, 'kevin');
  assert.ok(parsed.ts);
});

test('log.warn / log.error / log.debug share the shape', () => {
  const lines = [];
  setSink((line) => lines.push(line));
  // log.debug requires ROBIN_DEBUG=1 to emit; force on for this test.
  const prevDebug = process.env.ROBIN_DEBUG;
  process.env.ROBIN_DEBUG = '1';
  try {
    log.warn({ event: 'w' });
    log.error({ event: 'e' });
    log.debug({ event: 'd' });
  } finally {
    if (prevDebug === undefined) delete process.env.ROBIN_DEBUG;
    else process.env.ROBIN_DEBUG = prevDebug;
  }
  setSink(null);
  assert.strictEqual(lines.length, 3);
  assert.strictEqual(JSON.parse(lines[0]).level, 'warn');
  assert.strictEqual(JSON.parse(lines[1]).level, 'error');
  assert.strictEqual(JSON.parse(lines[2]).level, 'debug');
});

test('log requires an event field', () => {
  setSink(() => {});
  assert.throws(() => log.info({ count: 1 }), /event/);
  setSink(null);
});
