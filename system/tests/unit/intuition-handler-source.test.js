import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveSourceForHandler } from '../../cognition/intuition/handler.js';

test('ROBIN_SOURCE env wins', () => {
  const r = resolveSourceForHandler({ env: { ROBIN_SOURCE: 'agent:custom' } });
  assert.equal(r, 'agent:custom');
});

test('CLAUDE_PROJECT_DIR → agent:claude-code', () => {
  const r = resolveSourceForHandler({ env: { CLAUDE_PROJECT_DIR: '/x' } });
  assert.equal(r, 'agent:claude-code');
});

test('GEMINI_CLI_SESSION → agent:gemini-cli', () => {
  const r = resolveSourceForHandler({ env: { GEMINI_CLI_SESSION: 'abc' } });
  assert.equal(r, 'agent:gemini-cli');
});

test('no signal → null', () => {
  const r = resolveSourceForHandler({ env: {} });
  assert.equal(r, null);
});
