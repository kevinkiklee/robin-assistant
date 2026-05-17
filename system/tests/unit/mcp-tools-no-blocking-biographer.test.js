import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const TOOLS_DIR = resolve(import.meta.dirname, '../../io/mcp/tools');

const FORBIDDEN_PATTERNS = [
  { pattern: /\bawait\s+processor\s*\(/g, label: 'await processor(' },
  { pattern: /\bawait\s+queue\.enqueue\s*\(/g, label: 'await queue.enqueue(' },
  { pattern: /\bawait\s+ctx\.queue\.enqueue\s*\(/g, label: 'await ctx.queue.enqueue(' },
];

test('MCP tools do not synchronously await biographer enqueue (hidden hang)', () => {
  const files = readdirSync(TOOLS_DIR).filter((f) => f.endsWith('.js'));
  const offenses = [];
  for (const file of files) {
    const src = readFileSync(join(TOOLS_DIR, file), 'utf8');
    for (const { pattern, label } of FORBIDDEN_PATTERNS) {
      pattern.lastIndex = 0;
      if (pattern.test(src)) offenses.push(`${file}: contains "${label}"`);
    }
  }
  assert.deepEqual(
    offenses,
    [],
    `Forbidden blocking pattern(s) in MCP tool handlers — each one blocks the MCP ` +
      `channel for the full biographer LLM call (5–30s+). Use fire-and-forget instead:\n` +
      `  processor(id).catch((e) => console.warn(...));\n\n` +
      offenses.join('\n'),
  );
});
