import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { strict as assert } from 'node:assert';

import { createIngestTool } from '../../io/mcp/tools/ingest.js';

// We exercise the file_path branch via the tool's `handler` early-exit
// path: acquireContent runs before any DB or LLM dependency, so a stub
// host/db/embedder is fine — the call returns from the error branch.
function makeTool() {
  return createIngestTool({
    db: { query: () => ({ collect: async () => [[]] }) },
    embedder: { embed: async () => new Float32Array(8) },
    host: { invokeLLM: async () => ({ content: '{}' }) },
  });
}

test('ingest refuses files outside $HOME', async () => {
  const tool = makeTool();
  const result = await tool.handler({ file_path: '/etc/hosts' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'outside_home');
});

test('ingest refuses ../ traversal that escapes home', async () => {
  const tool = makeTool();
  const traversal = join(homedir(), '..', '..', 'etc', 'hosts');
  const result = await tool.handler({ file_path: traversal });
  assert.equal(result.ok, false);
  // realpath canonicalises and detects either outside_home or not_found
  // depending on what /etc/hosts looks like on the runner — both are safe.
  assert.ok(['outside_home', 'not_found'].includes(result.reason), `got ${result.reason}`);
});

test('ingest refuses symlink that points outside $HOME', async () => {
  const tmpHome = mkdtempSync(join(homedir(), '.robin-test-allowlist-'));
  const link = join(tmpHome, 'escape');
  symlinkSync('/etc/hosts', link);
  const tool = makeTool();
  const result = await tool.handler({ file_path: link });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'outside_home');
});

test('ingest accepts a real file under $HOME', async () => {
  const tmpHome = mkdtempSync(join(homedir(), '.robin-test-allowlist-'));
  const path = join(tmpHome, 'note.md');
  writeFileSync(path, 'hello from home');
  const tool = makeTool();
  // The stub db doesn't satisfy the full recordEvent contract, so anything
  // past the allowlist may throw. What we care about for *this* test is
  // that the failure isn't an allowlist refusal — outside_home or not_found
  // would mean the boundary check rejected the path.
  let result;
  try {
    result = await tool.handler({ file_path: path });
  } catch {
    return; // downstream throw → allowlist passed
  }
  assert.notEqual(result.reason, 'outside_home');
  assert.notEqual(result.reason, 'not_found');
});

test('ingest refuses non-existent files', async () => {
  const tool = makeTool();
  const result = await tool.handler({
    file_path: join(tmpdir(), 'definitely-not-there-' + Date.now()),
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'not_found');
});
