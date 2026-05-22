import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { GeminiProvider } from './gemini.ts';

function makeFakeGemini(output: string, exitCode = 0): { path: string; args: string } {
  const dir = mkdtempSync(join(tmpdir(), 'robin-gemini-mock-'));
  const path = join(dir, 'fake-gemini');
  const argsPath = join(dir, 'last-args');
  // Bash mock that records its argv to a sibling file and emits `output`.
  const script = `#!/usr/bin/env bash
printf '%s\\n' "$@" > '${argsPath}'
cat <<'EOF'
${output}
EOF
exit ${exitCode}
`;
  writeFileSync(path, script);
  chmodSync(path, 0o755);
  return { path, args: argsPath };
}

test('gemini-cli: invokes mock binary and returns text from JSON response', async () => {
  const { path: fake } = makeFakeGemini(JSON.stringify({ response: 'hi from gemini' }));
  const p = new GeminiProvider({ command: fake });
  const r = await p.invoke({ messages: [{ role: 'user', content: 'hello' }] });
  assert.equal(r.text, 'hi from gemini');
  assert.equal(r.provider, 'gemini-cli');
});

test('gemini-cli: extracts usage from stats.models envelope', async () => {
  const envelope = JSON.stringify({
    response: 'ok',
    stats: {
      models: {
        'gemini-2.5-flash': { tokens: { prompt: 123, candidates: 45, cached: 6 } },
      },
    },
  });
  const { path: fake } = makeFakeGemini(envelope);
  const p = new GeminiProvider({ command: fake });
  const r = await p.invoke({ messages: [{ role: 'user', content: 'q' }] });
  assert.equal(r.usage.inputTokens, 123);
  assert.equal(r.usage.outputTokens, 45);
  assert.equal(r.usage.cachedInputTokens, 6);
});

test('gemini-cli: falls back to plain text when output is not JSON', async () => {
  const { path: fake } = makeFakeGemini('plain text output');
  const p = new GeminiProvider({ command: fake });
  const r = await p.invoke({ messages: [{ role: 'user', content: 'hello' }] });
  assert.match(r.text, /plain text output/);
});

test('gemini-cli: throws on non-zero exit', async () => {
  const { path: fake } = makeFakeGemini('boom', 1);
  const p = new GeminiProvider({ command: fake });
  await assert.rejects(p.invoke({ messages: [{ role: 'user', content: 'hi' }] }), /exited 1/);
});

test('gemini-cli: passes --approval-mode plan to disable tool calls', async () => {
  const { path: fake, args } = makeFakeGemini(JSON.stringify({ response: 'ok' }));
  const p = new GeminiProvider({ command: fake });
  await p.invoke({ messages: [{ role: 'user', content: 'q' }] });
  const { readFileSync } = await import('node:fs');
  const written = readFileSync(args, 'utf8');
  assert.match(written, /--approval-mode/);
  assert.match(written, /\nplan\n/);
});

test('gemini-cli: tier maps to model arg', async () => {
  const { path: fake, args } = makeFakeGemini(JSON.stringify({ response: 'ok' }));
  const p = new GeminiProvider({ command: fake, tier: 'deep' });
  await p.invoke({ messages: [{ role: 'user', content: 'q' }] });
  const { readFileSync } = await import('node:fs');
  const written = readFileSync(args, 'utf8');
  assert.match(written, /gemini-2\.5-pro/);
});

test('gemini-cli: explicit model overrides tier', async () => {
  const { path: fake, args } = makeFakeGemini(JSON.stringify({ response: 'ok' }));
  const p = new GeminiProvider({ command: fake, tier: 'deep', model: 'gemini-2.5-flash-lite' });
  await p.invoke({ messages: [{ role: 'user', content: 'q' }] });
  const { readFileSync } = await import('node:fs');
  const written = readFileSync(args, 'utf8');
  assert.match(written, /gemini-2\.5-flash-lite/);
  assert.doesNotMatch(written, /gemini-2\.5-pro/);
});

test('gemini-cli: default capabilities cover daemon roles', () => {
  const p = new GeminiProvider({ command: 'gemini' });
  for (const role of ['interactive', 'agentic', 'reasoning', 'summarize', 'classify']) {
    assert.ok(p.capabilities.has(role as 'reasoning'), `missing role: ${role}`);
  }
});
