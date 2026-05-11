import assert from 'node:assert/strict';
import { test } from 'node:test';
import { detectHost } from '../../runtime/hosts/detect.js';

function clearHostEnv() {
  Reflect.deleteProperty(process.env, 'CLAUDE_PROJECT_DIR');
  Reflect.deleteProperty(process.env, 'GEMINI_API_KEY');
  Reflect.deleteProperty(process.env, 'ROBIN_HOST');
}

test('detectHost returns claude-code when CLAUDE_PROJECT_DIR is set', async () => {
  clearHostEnv();
  process.env.CLAUDE_PROJECT_DIR = '/tmp/test';
  const host = await detectHost({ skipAvailabilityCheck: true });
  assert.equal(host.name, 'claude-code');
  clearHostEnv();
});

test('detectHost honors ROBIN_HOST=gemini-cli override', async () => {
  clearHostEnv();
  process.env.ROBIN_HOST = 'gemini-cli';
  const host = await detectHost({ skipAvailabilityCheck: true });
  assert.equal(host.name, 'gemini-cli');
  clearHostEnv();
});

test('detectHost honors ROBIN_HOST=claude-code override (even when GEMINI_API_KEY set)', async () => {
  clearHostEnv();
  process.env.GEMINI_API_KEY = 'test';
  process.env.ROBIN_HOST = 'claude-code';
  const host = await detectHost({ skipAvailabilityCheck: true });
  assert.equal(host.name, 'claude-code');
  clearHostEnv();
});

test('detectHost throws when no host is detectable and skipAvailabilityCheck is true', async () => {
  clearHostEnv();
  await assert.rejects(detectHost({ skipAvailabilityCheck: true }), /no host/i);
});

test('detectHost ignores unknown ROBIN_HOST and falls through to heuristics', async () => {
  clearHostEnv();
  process.env.ROBIN_HOST = 'totally_made_up';
  process.env.CLAUDE_PROJECT_DIR = '/tmp/test';
  const host = await detectHost({ skipAvailabilityCheck: true });
  assert.equal(host.name, 'claude-code');
  clearHostEnv();
});
