import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

function seedConfig(home) {
  mkdirSync(join(home, 'config'), { recursive: true });
  writeFileSync(
    join(home, 'config', 'config.json'),
    JSON.stringify({ embedder_profile: 'mxbai-1024' }),
  );
}

test('robin mcp install with --no-supervise --no-register --no-start writes supervisor + AGENTS.md', () => {
  const tmpHome = mkdtempSync(join(tmpdir(), 'robin-install-home-'));
  const tmpRobin = mkdtempSync(join(tmpdir(), 'robin-install-robin-'));
  // Override packageRootDir() so CLAUDE.local.md writes go into the tempdir
  // instead of polluting the real workspace.
  const tmpPkgRoot = mkdtempSync(join(tmpdir(), 'robin-install-pkg-'));
  writeFileSync(join(tmpPkgRoot, 'package.json'), '{}', 'utf8');
  seedConfig(tmpRobin);
  const root = resolve(import.meta.dirname, '../../..');
  const localClaudePath = join(tmpPkgRoot, 'CLAUDE.local.md');
  const localGeminiPath = join(tmpPkgRoot, 'GEMINI.local.md');
  // Migrate first so daemon-running check has migrations applied.
  spawnSync(process.execPath, [join(root, 'system/bin/robin'), 'migrate'], {
    env: { ...process.env, ROBIN_HOME: tmpRobin },
    stdio: 'pipe',
  });
  const result = spawnSync(
    'node',
    [
      join(root, 'system/bin/robin'),
      'mcp',
      'install',
      '--no-supervise',
      '--no-register',
      '--no-start',
    ],
    {
      env: {
        ...process.env,
        ROBIN_HOME: tmpRobin,
        HOME: tmpHome,
        ROBIN_PACKAGE_ROOT_OVERRIDE: tmpPkgRoot,
      },
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

  // AGENTS.md files — workspace-local (auto-content stays project-scoped;
  // the global ~/.claude/CLAUDE.md is no longer touched by install).
  assert.ok(existsSync(localClaudePath), 'CLAUDE.local.md should exist');
  assert.ok(existsSync(localGeminiPath), 'GEMINI.local.md should exist');
  const claude = readFileSync(localClaudePath, 'utf8');
  assert.match(claude, /<!-- robin-mcp:start -->/);
  assert.match(claude, /recall/);
  // Global must stay clean: install must not write into HOME's claude/gemini dirs.
  assert.ok(
    !existsSync(join(tmpHome, '.claude/CLAUDE.md')),
    'install should not write to ~/.claude/CLAUDE.md',
  );
  assert.ok(
    !existsSync(join(tmpHome, '.gemini/GEMINI.md')),
    'install should not write to ~/.gemini/GEMINI.md',
  );

  rmSync(tmpHome, { recursive: true });
  rmSync(tmpRobin, { recursive: true });
  rmSync(tmpPkgRoot, { recursive: true });
});

test('install merges fenced section into existing CLAUDE.local.md', () => {
  const tmpHome = mkdtempSync(join(tmpdir(), 'robin-install-existing-'));
  const tmpRobin = mkdtempSync(join(tmpdir(), 'robin-install-existing-robin-'));
  const tmpPkgRoot = mkdtempSync(join(tmpdir(), 'robin-install-existing-pkg-'));
  writeFileSync(join(tmpPkgRoot, 'package.json'), '{}', 'utf8');
  seedConfig(tmpRobin);
  const root = resolve(import.meta.dirname, '../../..');
  const localClaudePath = join(tmpPkgRoot, 'CLAUDE.local.md');
  // Pre-create CLAUDE.local.md with personal content.
  writeFileSync(localClaudePath, '# My personal notes\nSomething about me.\n', 'utf8');

  spawnSync(process.execPath, [join(root, 'system/bin/robin'), 'migrate'], {
    env: { ...process.env, ROBIN_HOME: tmpRobin },
    stdio: 'pipe',
  });
  spawnSync(
    'node',
    [
      join(root, 'system/bin/robin'),
      'mcp',
      'install',
      '--no-supervise',
      '--no-register',
      '--no-start',
    ],
    {
      env: {
        ...process.env,
        ROBIN_HOME: tmpRobin,
        HOME: tmpHome,
        ROBIN_PACKAGE_ROOT_OVERRIDE: tmpPkgRoot,
      },
      stdio: 'pipe',
      encoding: 'utf8',
    },
  );
  const claude = readFileSync(localClaudePath, 'utf8');
  assert.match(claude, /My personal notes/);
  assert.match(claude, /Something about me/);
  assert.match(claude, /<!-- robin-mcp:start -->/);
  rmSync(tmpHome, { recursive: true });
  rmSync(tmpRobin, { recursive: true });
  rmSync(tmpPkgRoot, { recursive: true });
});
