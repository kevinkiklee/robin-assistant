import assert from 'node:assert';
import test from 'node:test';
import { errorEnvelope, okEnvelope } from '../../runtime/cli/json-envelope.js';

test('okEnvelope wraps data with command + ok:true + took_ms', () => {
  const env = okEnvelope({ command: 'hot', data: { items: [1, 2] }, took_ms: 47 });
  assert.strictEqual(env.ok, true);
  assert.strictEqual(env.command, 'hot');
  assert.deepStrictEqual(env.data, { items: [1, 2] });
  assert.strictEqual(env.took_ms, 47);
  assert.strictEqual(env.error, undefined);
});

test('errorEnvelope wraps reason + message with ok:false', () => {
  const env = errorEnvelope({
    command: 'publish',
    reason: 'missing_secret',
    message: 'BLOB_READ_WRITE_TOKEN not set',
    took_ms: 12,
  });
  assert.strictEqual(env.ok, false);
  assert.strictEqual(env.command, 'publish');
  assert.deepStrictEqual(env.error, {
    reason: 'missing_secret',
    message: 'BLOB_READ_WRITE_TOKEN not set',
  });
  assert.strictEqual(env.took_ms, 12);
  assert.strictEqual(env.data, undefined);
});

test('envelopes are JSON-serializable round-trip', () => {
  const env = okEnvelope({ command: 'cmd', data: { x: 1 }, took_ms: 0 });
  const parsed = JSON.parse(JSON.stringify(env));
  assert.deepStrictEqual(parsed, env);
});
