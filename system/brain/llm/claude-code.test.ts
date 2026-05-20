import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ClaudeCodeProvider } from './claude-code.ts';

function makeFakeClaude(output: string, exitCode = 0): string {
  const dir = mkdtempSync(join(tmpdir(), 'robin-claude-mock-'));
  const path = join(dir, 'fake-claude');
  const script = `#!/usr/bin/env bash
cat <<'EOF'
${output}
EOF
exit ${exitCode}
`;
  writeFileSync(path, script);
  chmodSync(path, 0o755);
  return path;
}

test('claude-code: invokes mock binary and returns text from JSON result', async () => {
  const fake = makeFakeClaude(JSON.stringify({ result: 'hi from claude' }));
  const p = new ClaudeCodeProvider({ command: fake });
  const r = await p.invoke({ messages: [{ role: 'user', content: 'hello' }] });
  assert.equal(r.text, 'hi from claude');
  assert.equal(r.provider, 'claude-code');
});

test('claude-code: falls back to plain text when output is not JSON', async () => {
  const fake = makeFakeClaude('plain text output');
  const p = new ClaudeCodeProvider({ command: fake });
  const r = await p.invoke({ messages: [{ role: 'user', content: 'hello' }] });
  assert.match(r.text, /plain text output/);
});

test('claude-code: throws on non-zero exit', async () => {
  const fake = makeFakeClaude('boom', 1);
  const p = new ClaudeCodeProvider({ command: fake });
  await assert.rejects(p.invoke({ messages: [{ role: 'user', content: 'hi' }] }), /exited 1/);
});
