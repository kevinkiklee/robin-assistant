import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  type McpServerConfigLike,
  mcpServersForRun,
  robinMcpServers,
  serversForTools,
} from './mcp-servers.ts';

/** Fake repo root with a built CLI binary so resolveRunnableCommand resolves. */
function fakeRepoWithDist(): string {
  const root = mkdtempSync(join(tmpdir(), 'robin-mcp-servers-'));
  const distDir = join(root, 'dist', 'surfaces', 'cli');
  mkdirSync(distDir, { recursive: true });
  writeFileSync(join(distDir, 'index.js'), '#!/usr/bin/env node\n');
  return root;
}

test('robinMcpServers: builds core + extension stdio configs from repoRoot', () => {
  const root = fakeRepoWithDist();
  const servers = robinMcpServers({ repoRoot: root, userDataDir: '/data/robin' });

  assert.deepEqual(Object.keys(servers).sort(), ['robin', 'robin-extension']);

  const core = servers.robin;
  assert.equal(core.type, 'stdio');
  assert.equal(core.command, join(root, 'dist', 'surfaces', 'cli', 'index.js'));
  assert.deepEqual(core.args, ['mcp', 'core']);
  assert.deepEqual(core.env, { ROBIN_USER_DATA_DIR: '/data/robin' });

  const ext = servers['robin-extension'];
  assert.equal(ext.type, 'stdio');
  assert.equal(ext.command, join(root, 'dist', 'surfaces', 'cli', 'index.js'));
  assert.deepEqual(ext.args, ['mcp', 'extension']);
  assert.deepEqual(ext.env, { ROBIN_USER_DATA_DIR: '/data/robin' });
});

test('robinMcpServers: omits env when no userDataDir given', () => {
  const prior = process.env.ROBIN_USER_DATA_DIR;
  delete process.env.ROBIN_USER_DATA_DIR;
  try {
    const root = fakeRepoWithDist();
    const servers = robinMcpServers({ repoRoot: root });
    assert.equal(servers.robin.env, undefined);
    assert.equal(servers['robin-extension'].env, undefined);
  } finally {
    if (prior !== undefined) process.env.ROBIN_USER_DATA_DIR = prior;
  }
});

test('robinMcpServers: throws a build hint when dist binary is missing', () => {
  const root = mkdtempSync(join(tmpdir(), 'robin-mcp-nodist-'));
  assert.throws(() => robinMcpServers({ repoRoot: root }), /pnpm build/);
});

const ALL: Record<string, McpServerConfigLike> = {
  robin: { type: 'stdio', command: '/r', args: ['mcp', 'core'] },
  'robin-extension': { type: 'stdio', command: '/r', args: ['mcp', 'extension'] },
};

test('serversForTools: extension-only tool list → just robin-extension', () => {
  const tools = [
    'mcp__robin-extension__gmail',
    'mcp__robin-extension__google_calendar',
    'mcp__robin-extension__github',
  ];
  const subset = serversForTools(tools, ALL);
  assert.deepEqual(Object.keys(subset), ['robin-extension']);
  assert.equal(subset['robin-extension'], ALL['robin-extension']);
});

test('serversForTools: core-only tool list → just robin', () => {
  const subset = serversForTools(['mcp__robin__recall', 'mcp__robin__remember'], ALL);
  assert.deepEqual(Object.keys(subset), ['robin']);
});

test('serversForTools: mixed tools → both servers, deduped', () => {
  const tools = ['mcp__robin__recall', 'mcp__robin-extension__gmail', 'mcp__robin__believe'];
  const subset = serversForTools(tools, ALL);
  assert.deepEqual(Object.keys(subset).sort(), ['robin', 'robin-extension']);
});

test('serversForTools: built-in-only tool list → empty map', () => {
  const subset = serversForTools(['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash'], ALL);
  assert.deepEqual(subset, {});
});

test('serversForTools: empty tool list → empty map', () => {
  assert.deepEqual(serversForTools([], ALL), {});
});

test('serversForTools: tool naming a server absent from the map is skipped', () => {
  const subset = serversForTools(['mcp__chrome-devtools__click', 'mcp__robin__recall'], ALL);
  assert.deepEqual(Object.keys(subset), ['robin']);
});

test('mcpServersForRun: built-in-only tools short-circuit (no build required)', () => {
  // repoRoot has no dist/ — robinMcpServers would throw if it were reached.
  const root = mkdtempSync(join(tmpdir(), 'robin-mcp-noreach-'));
  const subset = mcpServersForRun(['WebSearch', 'WebFetch', 'Read'], { repoRoot: root });
  assert.deepEqual(subset, {});
});

test('mcpServersForRun: core tools resolve just the robin server', () => {
  const root = fakeRepoWithDist();
  const subset = mcpServersForRun(['mcp__robin__recall', 'Read'], {
    repoRoot: root,
    userDataDir: '/data/robin',
  });
  assert.deepEqual(Object.keys(subset), ['robin']);
  assert.deepEqual(subset.robin.args, ['mcp', 'core']);
});
