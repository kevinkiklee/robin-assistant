import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildRobinMcpEntry, resolveRunnableCommand, upsertUserScopeMcp } from './write.ts';

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
  assert.equal(config.mcpServers.github.command, 'gh-mcp');
  assert.ok(config.mcpServers.robin);
});

test('upsertUserScopeMcp: handles malformed .claude.json by overwriting', () => {
  const home = fakeHome();
  writeFileSync(join(home, '.claude.json'), '{not json');
  const r = upsertUserScopeMcp(buildRobinMcpEntry({ command: '/r' }), { home });
  const config = JSON.parse(readFileSync(r.path, 'utf8'));
  assert.ok(config.mcpServers.robin);
});

test('buildRobinMcpEntry: includes env.ROBIN_USER_DATA_DIR when provided', () => {
  const entry = buildRobinMcpEntry({ command: '/r', userDataDir: '/data/robin' });
  assert.deepEqual(entry.env, { ROBIN_USER_DATA_DIR: '/data/robin' });
});

test('buildRobinMcpEntry: omits env when no userDataDir and env not set', () => {
  const prior = process.env.ROBIN_USER_DATA_DIR;
  delete process.env.ROBIN_USER_DATA_DIR;
  try {
    const entry = buildRobinMcpEntry({ command: '/r' });
    assert.equal(entry.env, undefined);
  } finally {
    if (prior !== undefined) process.env.ROBIN_USER_DATA_DIR = prior;
  }
});

test('buildRobinMcpEntry: inherits ROBIN_USER_DATA_DIR from process env', () => {
  const prior = process.env.ROBIN_USER_DATA_DIR;
  process.env.ROBIN_USER_DATA_DIR = '/from/env';
  try {
    const entry = buildRobinMcpEntry({ command: '/r' });
    assert.deepEqual(entry.env, { ROBIN_USER_DATA_DIR: '/from/env' });
  } finally {
    if (prior === undefined) delete process.env.ROBIN_USER_DATA_DIR;
    else process.env.ROBIN_USER_DATA_DIR = prior;
  }
});

test('buildRobinMcpEntry: surface=core (default) emits args [mcp, core]', () => {
  const entry = buildRobinMcpEntry({ command: '/r' });
  assert.deepEqual(entry.args, ['mcp', 'core']);
});

test('buildRobinMcpEntry: surface=extension emits args [mcp, extension]', () => {
  const entry = buildRobinMcpEntry({ command: '/r', surface: 'extension' });
  assert.deepEqual(entry.args, ['mcp', 'extension']);
});

test('upsertUserScopeMcp: opts.name lets caller install under a non-default key', () => {
  const home = fakeHome();
  const coreEntry = buildRobinMcpEntry({ command: '/r', surface: 'core' });
  const extEntry = buildRobinMcpEntry({ command: '/r', surface: 'extension' });
  upsertUserScopeMcp(coreEntry, { home, name: 'robin' });
  upsertUserScopeMcp(extEntry, { home, name: 'robin-extension' });
  const config = JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8'));
  assert.deepEqual(config.mcpServers.robin.args, ['mcp', 'core']);
  assert.deepEqual(config.mcpServers['robin-extension'].args, ['mcp', 'extension']);
});

test('resolveRunnableCommand: passes through non-.ts paths', () => {
  assert.equal(resolveRunnableCommand('/usr/local/bin/robin'), '/usr/local/bin/robin');
});

test('resolveRunnableCommand: rewrites .ts source path to dist/.js when built', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'robin-resolve-'));
  const sysDir = join(tmp, 'system', 'surfaces', 'cli');
  const distDir = join(tmp, 'dist', 'surfaces', 'cli');
  mkdirSync(sysDir, { recursive: true });
  mkdirSync(distDir, { recursive: true });
  writeFileSync(join(distDir, 'index.js'), '#!/usr/bin/env node\n');
  const resolved = resolveRunnableCommand(join(sysDir, 'index.ts'));
  assert.equal(resolved, join(distDir, 'index.js'));
});

test('resolveRunnableCommand: throws when .ts source has no compiled .js sibling', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'robin-resolve-'));
  const sysDir = join(tmp, 'system', 'surfaces', 'cli');
  mkdirSync(sysDir, { recursive: true });
  assert.throws(() => resolveRunnableCommand(join(sysDir, 'index.ts')), /pnpm build/);
});

test('resolveRunnableCommand: rejects empty input', () => {
  assert.throws(() => resolveRunnableCommand(''), /empty script path/);
});
