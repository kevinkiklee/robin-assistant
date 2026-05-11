import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

function seedConfig(home) {
  writeFileSync(join(home, 'config.json'), JSON.stringify({ embedder_profile: 'mxbai-1024' }));
}

test('robin mcp install with --no-supervise --no-register --no-start writes supervisor + AGENTS.md', () => {
  const tmpHome = mkdtempSync(join(tmpdir(), 'robin-install-home-'));
  const tmpRobin = mkdtempSync(join(tmpdir(), 'robin-install-robin-'));
  seedConfig(tmpRobin);
  const root = resolve(import.meta.dirname, '../..');
  // Migrate first so daemon-running check has migrations applied.
  spawnSync(process.execPath, [join(root, 'bin/robin'), 'migrate'], {
    env: { ...process.env, ROBIN_HOME: tmpRobin },
    stdio: 'pipe',
  });
  const result = spawnSync(
    'node',
    [join(root, 'bin/robin'), 'mcp', 'install', '--no-supervise', '--no-register', '--no-start'],
    {
      env: { ...process.env, ROBIN_HOME: tmpRobin, HOME: tmpHome },
      stdio: 'pipe',
      encoding: 'utf8',
    },
  );
  assert.equal(result.status, 0, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);

  // Platform-specific: macOS plist OR Linux systemd unit.
  if (process.platform === 'darwin') {
    const plistPath = join(tmpHome, 'Library/LaunchAgents/io.robin-assistant.mcp.plist');
    assert.ok(existsSync(plistPath), 'plist should exist');
    const xml = readFileSync(plistPath, 'utf8');
    assert.match(xml, /io\.robin-assistant\.mcp/);
    assert.match(xml, /KeepAlive/);
    // plutil -lint validates the XML if available.
    const lint = spawnSync('plutil', ['-lint', plistPath], { encoding: 'utf8' });
    if (lint.status === 0) {
      assert.match(lint.stdout, /OK/);
    }
  } else if (process.platform === 'linux') {
    const unitPath = join(tmpHome, '.config/systemd/user/robin-mcp.service');
    assert.ok(existsSync(unitPath), 'unit should exist');
  }

  // AGENTS.md files.
  assert.ok(existsSync(join(tmpHome, '.claude/CLAUDE.md')), 'CLAUDE.md should exist');
  assert.ok(existsSync(join(tmpHome, '.gemini/GEMINI.md')), 'GEMINI.md should exist');
  const claude = readFileSync(join(tmpHome, '.claude/CLAUDE.md'), 'utf8');
  assert.match(claude, /<!-- robin-mcp:start -->/);
  assert.match(claude, /recall/);

  rmSync(tmpHome, { recursive: true });
  rmSync(tmpRobin, { recursive: true });
});

test('install merges fenced section into existing CLAUDE.md', () => {
  const tmpHome = mkdtempSync(join(tmpdir(), 'robin-install-existing-'));
  const tmpRobin = mkdtempSync(join(tmpdir(), 'robin-install-existing-robin-'));
  seedConfig(tmpRobin);
  const root = resolve(import.meta.dirname, '../..');
  // Pre-create CLAUDE.md with personal content.
  const claudeDir = join(tmpHome, '.claude');
  mkdirSync(claudeDir, { recursive: true });
  writeFileSync(join(claudeDir, 'CLAUDE.md'), '# My personal notes\nSomething about me.\n', 'utf8');

  spawnSync(process.execPath, [join(root, 'bin/robin'), 'migrate'], {
    env: { ...process.env, ROBIN_HOME: tmpRobin },
    stdio: 'pipe',
  });
  spawnSync(
    'node',
    [join(root, 'bin/robin'), 'mcp', 'install', '--no-supervise', '--no-register', '--no-start'],
    {
      env: { ...process.env, ROBIN_HOME: tmpRobin, HOME: tmpHome },
      stdio: 'pipe',
      encoding: 'utf8',
    },
  );
  const claude = readFileSync(join(claudeDir, 'CLAUDE.md'), 'utf8');
  assert.match(claude, /My personal notes/);
  assert.match(claude, /Something about me/);
  assert.match(claude, /<!-- robin-mcp:start -->/);
  rmSync(tmpHome, { recursive: true });
  rmSync(tmpRobin, { recursive: true });
});
