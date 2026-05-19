import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { upsertUserScopeMcp, buildRobinMcpEntry } from './write.ts';

function fakeHome(): string {
  return mkdtempSync(join(tmpdir(), 'robin-mcp-cfg-'));
}

test('upsertUserScopeMcp: creates .claude.json with robin entry when absent', () => {
  const home = fakeHome();
  const entry = buildRobinMcpEntry({ command: '/usr/local/bin/robin' });
  const r = upsertUserScopeMcp(entry, { home });
  assert.equal(r.replaced, false);
  assert.ok(existsSync(r.path));
  const config = JSON.parse(readFileSync(r.path, 'utf8'));
  assert.deepEqual(config.mcpServers.robin, entry);
});

test('upsertUserScopeMcp: replaces existing robin entry (v2 supersede)', () => {
  const home = fakeHome();
  const oldEntry = { type: 'stdio', command: '/old/robin-v2', args: ['daemon'] };
  writeFileSync(join(home, '.claude.json'), JSON.stringify({ mcpServers: { robin: oldEntry } }));
  const entry = buildRobinMcpEntry({ command: '/new/robin' });
  const r = upsertUserScopeMcp(entry, { home });
  assert.equal(r.replaced, true);
  const config = JSON.parse(readFileSync(r.path, 'utf8'));
  assert.equal(config.mcpServers.robin.command, '/new/robin');
});

test('upsertUserScopeMcp: preserves other MCP server entries', () => {
  const home = fakeHome();
  writeFileSync(
    join(home, '.claude.json'),
    JSON.stringify({
      mcpServers: { github: { type: 'stdio', command: 'gh-mcp', args: [] } },
    }),
  );
  const r = upsertUserScopeMcp(buildRobinMcpEntry({ command: '/r' }), { home });
  const config = JSON.parse(readFileSync(r.path, 'utf8'));
  assert.equal(config.mcpServers['github'].command, 'gh-mcp');
  assert.ok(config.mcpServers.robin);
});

test('upsertUserScopeMcp: handles malformed .claude.json by overwriting', () => {
  const home = fakeHome();
  writeFileSync(join(home, '.claude.json'), '{not json');
  const r = upsertUserScopeMcp(buildRobinMcpEntry({ command: '/r' }), { home });
  const config = JSON.parse(readFileSync(r.path, 'utf8'));
  assert.ok(config.mcpServers.robin);
});
