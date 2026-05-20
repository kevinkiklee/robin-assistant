import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildDispatcherFromConfig } from './build-dispatcher.ts';

test('buildDispatcher: builds providers from models config', () => {
  const d = buildDispatcherFromConfig(
    {
      roles: {
        classify: { provider: 'ollama', model: 'qwen3:8b', baseUrl: 'http://127.0.0.1:11434' },
      },
    },
    { env: {} },
  );
  const p = d.getProvider('classify');
  assert.equal(p.name, 'ollama');
});

test('buildDispatcher: throws on missing secret in strict mode', () => {
  assert.throws(
    () =>
      buildDispatcherFromConfig(
        { roles: { reasoning: { provider: 'deepseek', apiKeyEnv: 'NEVER_SET' } } },
        { env: {} },
      ),
    /NEVER_SET/,
  );
});

test('buildDispatcher: skips broken provider in lenient mode', () => {
  let warned = '';
  const d = buildDispatcherFromConfig(
    { roles: { reasoning: { provider: 'deepseek', apiKeyEnv: 'NEVER_SET' } } },
    {
      env: {},
      lenient: true,
      onWarn: (m) => {
        warned = m;
      },
    },
  );
  assert.match(warned, /NEVER_SET/);
  assert.throws(() => d.getProvider('reasoning'), /No provider assigned/);
});

test('buildDispatcher: reuses single provider instance across roles using same provider+model', () => {
  const d = buildDispatcherFromConfig(
    {
      roles: {
        classify: { provider: 'ollama', model: 'qwen3:8b' },
        summarize: { provider: 'ollama', model: 'qwen3:8b' },
      },
    },
    { env: {} },
  );
  assert.strictEqual(d.getProvider('classify'), d.getProvider('summarize'));
});
