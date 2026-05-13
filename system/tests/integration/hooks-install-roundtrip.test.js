import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readHostIntegrations } from '../../config/data-store.js';

function setup() {
  const root = join(
    tmpdir(),
    `robin-hooks-roundtrip-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  const homeDir = join(root, 'home');
  const robinHome = join(root, 'robin-home');
  const packageRoot = join(root, 'pkg');
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(robinHome, { recursive: true });
  // acquireManifestLock opens <robinHome>/runtime/install/.manifest.lock;
  // pre-create the dir so the openSync doesn't ENOENT in tests that bypass
  // ensureHome().
  mkdirSync(join(robinHome, 'runtime', 'install'), { recursive: true });
  mkdirSync(join(packageRoot, 'system', 'bin'), { recursive: true });
  writeFileSync(join(packageRoot, 'system', 'bin', 'robin-hook.sh'), '#!/bin/sh\nexit 0\n', {
    mode: 0o755,
  });
  process.env.ROBIN_HOME = robinHome;
  return { root, homeDir, robinHome, packageRoot };
}

function cleanup(root) {
  rmSync(root, { recursive: true, force: true });
}

test('full install/uninstall cycle: foreign entries survive byte-for-byte', async () => {
  const env = setup();
  try {
    const claudePath = join(env.homeDir, '.claude/settings.json');
    const geminiPath = join(env.homeDir, '.gemini/settings.json');
    mkdirSync(join(env.homeDir, '.claude'), { recursive: true });
    mkdirSync(join(env.homeDir, '.gemini'), { recursive: true });

    const claudeOriginal = {
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [{ type: 'command', command: '/usr/local/bin/foreign-bash --strict' }],
          },
          {
            matcher: 'Write',
            hooks: [{ type: 'command', command: '/usr/local/bin/foreign-write' }],
          },
        ],
        Stop: [{ hooks: [{ type: 'command', command: '/usr/local/bin/foreign-stop' }] }],
      },
      env: { FOO: 'bar' },
      otherKey: { nested: { deeply: [1, 2, 3, 'four'] } },
    };
    const geminiOriginal = {
      hooks: {
        SessionStart: [{ hooks: [{ type: 'command', command: '/opt/foreign/start' }] }],
      },
      mySetting: 'value',
    };

    writeFileSync(claudePath, JSON.stringify(claudeOriginal), 'utf8');
    writeFileSync(geminiPath, JSON.stringify(geminiOriginal), 'utf8');

    const { installHooksToSettings, uninstallHooksFromSettings } = await import(
      `../../runtime/install/hooks-settings.js?cb=${Date.now()}-${Math.random()}`
    );

    // Install.
    const { addedByHost } = await installHooksToSettings({
      homeDir: env.homeDir,
      packageRoot: env.packageRoot,
    });
    assert.equal(addedByHost.claude, 4, 'claude added 4');
    assert.equal(addedByHost.gemini, 3, 'gemini added 3');

    // Robin entries appear.
    const claudeAfterInstall = JSON.parse(readFileSync(claudePath, 'utf8'));
    const shimPath = join(env.packageRoot, 'system', 'bin', 'robin-hook.sh');
    const robinPhases = ['PreToolUse', 'UserPromptSubmit', 'SessionStart', 'Stop'];
    for (const phase of robinPhases) {
      const arr = claudeAfterInstall.hooks[phase];
      assert.ok(
        arr.some((e) =>
          e.hooks?.some((h) => typeof h.command === 'string' && h.command.startsWith(shimPath)),
        ),
        `claude ${phase} should contain robin entry`,
      );
    }

    // Manifest entries exist in unified host-integrations.json.
    const integrations = await readHostIntegrations();
    assert.ok(
      integrations.entries.some((e) => e.kind === 'claude-hooks'),
      'claude-hooks entry should be in manifest after install',
    );

    // Uninstall.
    const { removedByHost } = await uninstallHooksFromSettings({
      homeDir: env.homeDir,
      packageRoot: env.packageRoot,
    });
    assert.equal(removedByHost.claude, 4);
    assert.equal(removedByHost.gemini, 3);

    // Foreign entries survive byte-for-byte (compared by JSON.stringify of
    // the hooks subtree against the original).
    const claudeAfterUninstall = JSON.parse(readFileSync(claudePath, 'utf8'));
    const geminiAfterUninstall = JSON.parse(readFileSync(geminiPath, 'utf8'));

    assert.equal(
      JSON.stringify(claudeAfterUninstall.hooks),
      JSON.stringify(claudeOriginal.hooks),
      'claude hooks subtree byte-identical after roundtrip',
    );
    assert.equal(
      JSON.stringify(claudeAfterUninstall.env),
      JSON.stringify(claudeOriginal.env),
      'claude env preserved',
    );
    assert.equal(
      JSON.stringify(claudeAfterUninstall.otherKey),
      JSON.stringify(claudeOriginal.otherKey),
      'claude otherKey preserved',
    );

    assert.equal(
      JSON.stringify(geminiAfterUninstall.hooks),
      JSON.stringify(geminiOriginal.hooks),
      'gemini hooks subtree byte-identical after roundtrip',
    );
    assert.equal(geminiAfterUninstall.mySetting, geminiOriginal.mySetting);

    // Manifest entries removed from unified manifest after uninstall.
    const integrationsAfter = await readHostIntegrations();
    assert.equal(
      integrationsAfter.entries.find((e) => e.kind === 'claude-hooks'),
      undefined,
      'claude-hooks entry should be removed after uninstall',
    );
  } finally {
    cleanup(env.root);
  }
});

test('roundtrip with no pre-existing settings files: clean install + clean uninstall', async () => {
  const env = setup();
  try {
    const { installHooksToSettings, uninstallHooksFromSettings } = await import(
      `../../runtime/install/hooks-settings.js?cb=${Date.now()}-${Math.random()}`
    );

    const { addedByHost } = await installHooksToSettings({
      homeDir: env.homeDir,
      packageRoot: env.packageRoot,
    });
    assert.equal(addedByHost.claude, 4);
    assert.equal(addedByHost.gemini, 3);

    const claudePath = join(env.homeDir, '.claude/settings.json');
    const geminiPath = join(env.homeDir, '.gemini/settings.json');
    assert.ok(existsSync(claudePath));
    assert.ok(existsSync(geminiPath));

    await uninstallHooksFromSettings({
      homeDir: env.homeDir,
      packageRoot: env.packageRoot,
    });

    // Files still exist (the keys we wrote remain) but should be empty / no
    // hooks key.
    const claudeAfter = JSON.parse(readFileSync(claudePath, 'utf8'));
    const geminiAfter = JSON.parse(readFileSync(geminiPath, 'utf8'));
    assert.equal(claudeAfter.hooks, undefined, 'claude hooks key removed when emptied');
    assert.equal(geminiAfter.hooks, undefined, 'gemini hooks key removed when emptied');
  } finally {
    cleanup(env.root);
  }
});
