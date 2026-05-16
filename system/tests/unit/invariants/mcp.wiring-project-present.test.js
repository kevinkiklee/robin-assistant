import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { writeConfig } from '../../../config/paths.js';
import { canonicalEntry } from '../../../runtime/invariants/mcp.wiring-project-present.js';
import mcpWiringProjectPresent from '../../../runtime/invariants/mcp.wiring-project-present.js';
import { makeTestCtx } from '../../helpers/invariant-fixtures.js';

const tmpRoot = join(tmpdir(), `robin-mcp-${process.pid}-${Math.random().toString(36).slice(2)}`);
mkdirSync(tmpRoot, { recursive: true });
process.env.ROBIN_HOME = tmpRoot;
// Make .mcp.json land in the tmpRoot's parent so we don't disturb the real one
process.env.ROBIN_PACKAGE_ROOT_OVERRIDE = tmpRoot;
await writeConfig({ embedder_profile: 'mxbai-1024', mcp: { port: 63532 } });

test('canonicalEntry returns the expected shape', () => {
  const entry = canonicalEntry(63532);
  assert.equal(entry.type, 'sse');
  assert.equal(entry.url, 'http://127.0.0.1:63532/sse');
});

test('check fails when .mcp.json missing', async () => {
  // No .mcp.json in tmpRoot
  const result = await mcpWiringProjectPresent.check();
  assert.equal(result.ok, false);
  assert.equal(result.error, 'file_missing');
});

test('check fails on URL mismatch', async () => {
  const path = join(tmpRoot, '.mcp.json');
  writeFileSync(path, JSON.stringify({ mcpServers: { robin: { type: 'sse', url: 'http://127.0.0.1:99999/sse' } } }));
  const result = await mcpWiringProjectPresent.check();
  assert.equal(result.ok, false);
  assert.equal(result.error, 'url_mismatch');
});

test('check passes on canonical entry', async () => {
  const path = join(tmpRoot, '.mcp.json');
  writeFileSync(path, JSON.stringify({ mcpServers: { robin: canonicalEntry(63532) } }));
  const result = await mcpWiringProjectPresent.check();
  assert.equal(result.ok, true);
});

test('repair writes canonical entry', async () => {
  const path = join(tmpRoot, '.mcp.json');
  if (existsSync(path)) {
    writeFileSync(path, '{}');
  }
  const r = await mcpWiringProjectPresent.repair(makeTestCtx({ dryRun: false }));
  assert.equal(r.repaired, true);
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(parsed.mcpServers.robin.url, 'http://127.0.0.1:63532/sse');
});

test('repair dry-run does not write', async () => {
  const path = join(tmpRoot, '.mcp.json');
  writeFileSync(path, JSON.stringify({ mcpServers: { robin: { type: 'sse', url: 'http://127.0.0.1:1/sse' } } }));
  const r = await mcpWiringProjectPresent.repair(makeTestCtx({ dryRun: true }));
  assert.equal(r.repaired, false);
  assert.equal(r.action, 'would_write_project_mcp');
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(parsed.mcpServers.robin.url, 'http://127.0.0.1:1/sse');
});
