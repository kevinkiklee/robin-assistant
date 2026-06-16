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

test('buildDispatcher: wires a role fallback provider (usage-limit failover)', () => {
  const d = buildDispatcherFromConfig(
    {
      roles: {
        reasoning: {
          provider: 'ollama',
          model: 'qwen3:8b',
          fallback: { provider: 'ollama', model: 'qwen3:14b' },
        },
      },
    },
    { env: {} },
  );
  const primary = d.getProvider('reasoning');
  const fallback = d.getFallbackProvider('reasoning');
  assert.ok(fallback, 'a configured fallback is wired onto the role');
  assert.notStrictEqual(primary, fallback, 'the fallback is a distinct provider from the primary');
});

test('buildDispatcher: no fallback is wired when the role omits one', () => {
  const d = buildDispatcherFromConfig(
    { roles: { reasoning: { provider: 'ollama', model: 'qwen3:8b' } } },
    { env: {} },
  );
  assert.equal(d.getFallbackProvider('reasoning'), undefined);
});

test('buildDispatcher: a broken fallback is non-fatal in lenient mode (primary still works)', () => {
  let warned = '';
  const d = buildDispatcherFromConfig(
    {
      roles: {
        reasoning: {
          provider: 'ollama',
          model: 'qwen3:8b',
          fallback: { provider: 'deepseek', apiKeyEnv: 'NEVER_SET' },
        },
      },
    },
    {
      env: {},
      lenient: true,
      onWarn: (m) => {
        warned = m;
      },
    },
  );
  assert.match(warned, /fallback provider build failed/);
  assert.equal(d.getProvider('reasoning').name, 'ollama', 'the role still works on its primary');
  assert.equal(d.getFallbackProvider('reasoning'), undefined, 'the broken fallback is not wired');
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
