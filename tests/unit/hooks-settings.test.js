import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readHostIntegrations } from '../../src/runtime/data-store.js';

function makeFreshEnv() {
  const root = join(
    tmpdir(),
    `robin-hooks-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  const homeDir = join(root, 'home');
  const robinHome = join(root, 'robin-home');
  // Pretend the package root is our root (it just needs bin/robin-hook.sh under it).
  const packageRoot = join(root, 'pkg');
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(robinHome, { recursive: true });
  mkdirSync(join(packageRoot, 'bin'), { recursive: true });
  writeFileSync(join(packageRoot, 'bin', 'robin-hook.sh'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  process.env.ROBIN_HOME = robinHome;
  return { root, homeDir, robinHome, packageRoot };
}

function cleanup(root) {
  rmSync(root, { recursive: true, force: true });
}

async function importFresh() {
  return await import(`../../src/install/hooks-settings.js?cb=${Date.now()}-${Math.random()}`);
}

const FOREIGN_PRETOOL = {
  matcher: 'Bash',
  hooks: [{ type: 'command', command: '/usr/bin/foreign --check' }],
};
const FOREIGN_PROMPT = {
  hooks: [{ type: 'command', command: '/usr/bin/another' }],
};

test('installHooksToSettings adds robin entries and preserves foreign Claude entries', async () => {
  const env = makeFreshEnv();
  try {
    const claudePath = join(env.homeDir, '.claude/settings.json');
    mkdirSync(join(env.homeDir, '.claude'), { recursive: true });
    writeFileSync(
      claudePath,
      JSON.stringify({
        hooks: {
          PreToolUse: [FOREIGN_PRETOOL],
          UserPromptSubmit: [FOREIGN_PROMPT],
        },
        unrelated: { color: 'blue' },
      }),
      'utf8',
    );

    const { installHooksToSettings } = await importFresh();
    const { addedByHost } = await installHooksToSettings({
      homeDir: env.homeDir,
      packageRoot: env.packageRoot,
    });
    assert.equal(addedByHost.claude, 4, 'should have added 4 claude entries');

    const settings = JSON.parse(readFileSync(claudePath, 'utf8'));
    assert.deepEqual(settings.unrelated, { color: 'blue' }, 'unrelated keys preserved');

    // Foreign PreToolUse + UserPromptSubmit entries still present.
    const foreignPreToolStill = settings.hooks.PreToolUse.some(
      (e) =>
        Array.isArray(e.hooks) && e.hooks.some((h) => h.command === '/usr/bin/foreign --check'),
    );
    assert.ok(foreignPreToolStill, 'foreign PreToolUse entry should be preserved');
    const foreignPromptStill = settings.hooks.UserPromptSubmit.some(
      (e) => Array.isArray(e.hooks) && e.hooks.some((h) => h.command === '/usr/bin/another'),
    );
    assert.ok(foreignPromptStill, 'foreign UserPromptSubmit entry should be preserved');

    // Robin entries present for all four phases.
    const shim = join(env.packageRoot, 'bin', 'robin-hook.sh');
    const phases = ['PreToolUse', 'UserPromptSubmit', 'SessionStart', 'Stop'];
    for (const phase of phases) {
      const arr = settings.hooks[phase];
      assert.ok(Array.isArray(arr), `phase ${phase} should be an array`);
      const found = arr.some(
        (e) =>
          Array.isArray(e.hooks) &&
          e.hooks.some((h) => typeof h.command === 'string' && h.command.startsWith(shim)),
      );
      assert.ok(found, `phase ${phase} should contain a robin hook entry`);
    }

    // Manifest written to unified host-integrations.json.
    const integrations = await readHostIntegrations();
    const claudeEntry = integrations.entries.find(
      (e) => e.kind === 'claude-hooks' && e.path === join(env.homeDir, '.claude/settings.json'),
    );
    assert.ok(claudeEntry, 'claude-hooks entry should be in manifest');
    assert.ok(Array.isArray(claudeEntry.owned));
    assert.equal(claudeEntry.owned.length, 4);
    const geminiEntry = integrations.entries.find(
      (e) => e.kind === 'gemini-hooks' && e.path === join(env.homeDir, '.gemini/settings.json'),
    );
    assert.ok(geminiEntry, 'gemini-hooks entry should be in manifest');
    // Gemini gets 3 entries (no UserPromptSubmit).
    assert.equal(geminiEntry.owned.length, 3);
  } finally {
    cleanup(env.root);
  }
});

test('installHooksToSettings is idempotent (re-install adds nothing)', async () => {
  const env = makeFreshEnv();
  try {
    const { installHooksToSettings } = await importFresh();
    await installHooksToSettings({ homeDir: env.homeDir, packageRoot: env.packageRoot });
    const second = await installHooksToSettings({
      homeDir: env.homeDir,
      packageRoot: env.packageRoot,
    });
    assert.equal(second.addedByHost.claude, 0, 'second run should add 0 claude entries');
    assert.equal(second.addedByHost.gemini, 0, 'second run should add 0 gemini entries');
  } finally {
    cleanup(env.root);
  }
});

test('uninstallHooksFromSettings removes only robin entries; foreign entries survive byte-identical', async () => {
  const env = makeFreshEnv();
  try {
    const claudePath = join(env.homeDir, '.claude/settings.json');
    mkdirSync(join(env.homeDir, '.claude'), { recursive: true });
    const original = {
      hooks: {
        PreToolUse: [FOREIGN_PRETOOL],
        UserPromptSubmit: [FOREIGN_PROMPT],
      },
      unrelated: { color: 'blue', list: [1, 2, 3] },
    };
    writeFileSync(claudePath, JSON.stringify(original), 'utf8');

    const { installHooksToSettings, uninstallHooksFromSettings } = await importFresh();
    await installHooksToSettings({ homeDir: env.homeDir, packageRoot: env.packageRoot });
    const { removedByHost } = await uninstallHooksFromSettings({
      homeDir: env.homeDir,
      packageRoot: env.packageRoot,
    });
    assert.equal(removedByHost.claude, 4);

    const after = JSON.parse(readFileSync(claudePath, 'utf8'));
    assert.equal(
      JSON.stringify(after.hooks.PreToolUse),
      JSON.stringify(original.hooks.PreToolUse),
      'foreign PreToolUse byte-identical after uninstall',
    );
    assert.equal(
      JSON.stringify(after.hooks.UserPromptSubmit),
      JSON.stringify(original.hooks.UserPromptSubmit),
      'foreign UserPromptSubmit byte-identical after uninstall',
    );
    assert.equal(
      JSON.stringify(after.unrelated),
      JSON.stringify(original.unrelated),
      'unrelated keys byte-identical after uninstall',
    );

    // Manifest entries removed from unified manifest.
    const integrations = await readHostIntegrations();
    const claudeEntry = integrations.entries.find(
      (e) => e.kind === 'claude-hooks' && e.path === join(env.homeDir, '.claude/settings.json'),
    );
    assert.equal(claudeEntry, undefined, 'claude-hooks entry should be removed after uninstall');
  } finally {
    cleanup(env.root);
  }
});

test('Gemini settings: UserPromptSubmit is NOT installed', async () => {
  const env = makeFreshEnv();
  try {
    const { installHooksToSettings } = await importFresh();
    await installHooksToSettings({ homeDir: env.homeDir, packageRoot: env.packageRoot });
    const geminiPath = join(env.homeDir, '.gemini/settings.json');
    const settings = JSON.parse(readFileSync(geminiPath, 'utf8'));
    assert.ok(settings.hooks.PreToolUse, 'gemini PreToolUse should be present');
    assert.ok(settings.hooks.SessionStart, 'gemini SessionStart should be present');
    assert.ok(settings.hooks.Stop, 'gemini Stop should be present');
    assert.equal(
      settings.hooks.UserPromptSubmit,
      undefined,
      'gemini UserPromptSubmit should NOT be present',
    );
  } finally {
    cleanup(env.root);
  }
});

test('readHostIntegrations returns empty entries when manifest absent, populated when present', async () => {
  const env = makeFreshEnv();
  try {
    const { installHooksToSettings } = await importFresh();
    const before = await readHostIntegrations();
    assert.equal(before.entries.length, 0, 'no entries before install');
    await installHooksToSettings({ homeDir: env.homeDir, packageRoot: env.packageRoot });
    const after = await readHostIntegrations();
    assert.ok(after.entries.length >= 2, 'at least claude + gemini entries after install');
    const claudeEntry = after.entries.find((e) => e.kind === 'claude-hooks');
    assert.ok(claudeEntry, 'claude-hooks entry present');
    assert.ok(Array.isArray(claudeEntry.owned));
  } finally {
    cleanup(env.root);
  }
});

test('uninstall fallback (no manifest entry) removes any command starting with the shim path', async () => {
  const env = makeFreshEnv();
  try {
    const { installHooksToSettings, uninstallHooksFromSettings } = await importFresh();
    await installHooksToSettings({ homeDir: env.homeDir, packageRoot: env.packageRoot });
    // Delete the unified manifest file to force fallback path.
    rmSync(join(env.robinHome, 'host-integrations.json'), { force: true });

    const { removedByHost } = await uninstallHooksFromSettings({
      homeDir: env.homeDir,
      packageRoot: env.packageRoot,
    });
    assert.ok(removedByHost.claude >= 4, 'fallback should remove all claude robin entries');

    const claudePath = join(env.homeDir, '.claude/settings.json');
    const settings = JSON.parse(readFileSync(claudePath, 'utf8'));
    // No robin entries left anywhere.
    const allCommands = [];
    for (const arr of Object.values(settings.hooks ?? {})) {
      if (Array.isArray(arr)) {
        for (const e of arr) {
          if (Array.isArray(e?.hooks)) for (const h of e.hooks) allCommands.push(h.command);
        }
      }
    }
    assert.ok(!allCommands.some((c) => c?.includes('robin-hook.sh')));
  } finally {
    cleanup(env.root);
  }
});

test('malformed JSON in settings.json is skipped with warning, manifest still written', async () => {
  const env = makeFreshEnv();
  try {
    const claudePath = join(env.homeDir, '.claude/settings.json');
    mkdirSync(join(env.homeDir, '.claude'), { recursive: true });
    writeFileSync(claudePath, '{not valid json', 'utf8');

    const origStderrWrite = process.stderr.write.bind(process.stderr);
    let stderrCaptured = '';
    process.stderr.write = (chunk) => {
      stderrCaptured += String(chunk);
      return true;
    };
    try {
      const { installHooksToSettings } = await importFresh();
      const { addedByHost } = await installHooksToSettings({
        homeDir: env.homeDir,
        packageRoot: env.packageRoot,
      });
      assert.equal(addedByHost.claude, undefined, 'malformed claude settings should be skipped');
      assert.equal(addedByHost.gemini, 3, 'gemini should still install');
    } finally {
      process.stderr.write = origStderrWrite;
    }
    assert.match(stderrCaptured, /skipping hook install for claude/);

    // Original malformed file untouched.
    assert.equal(readFileSync(claudePath, 'utf8'), '{not valid json');
  } finally {
    cleanup(env.root);
  }
});

test('validateRobinResolvable passes when shim exists+executable', async () => {
  const env = makeFreshEnv();
  try {
    const { validateRobinResolvable } = await importFresh();
    const r = await validateRobinResolvable({ packageRoot: env.packageRoot });
    assert.equal(typeof r.robinOnPath, 'boolean');
    assert.equal(r.shimPath, join(env.packageRoot, 'bin', 'robin-hook.sh'));
  } finally {
    cleanup(env.root);
  }
});

test('validateRobinResolvable throws when neither robin nor shim is available', async () => {
  const env = makeFreshEnv();
  try {
    // Remove the shim so neither is reachable.
    rmSync(join(env.packageRoot, 'bin', 'robin-hook.sh'), { force: true });
    // Hide robin from PATH inside the probe shell.
    const origPath = process.env.PATH;
    process.env.PATH = '/nonexistent-path-xxx-robin-test';
    try {
      const { validateRobinResolvable } = await importFresh();
      let threw = false;
      try {
        await validateRobinResolvable({ packageRoot: env.packageRoot });
      } catch (e) {
        threw = true;
        assert.match(e.message, /hooks unreachable/);
      }
      assert.ok(threw, 'validateRobinResolvable should throw');
    } finally {
      process.env.PATH = origPath;
    }
  } finally {
    cleanup(env.root);
  }
});
