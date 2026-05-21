import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  HOOK_SIGNATURE,
  installSessionEndHook,
  robinHookCommand,
  uninstallSessionEndHook,
} from './install.ts';

function freshHome() {
  const home = mkdtempSync(join(tmpdir(), 'robin-hooks-'));
  mkdirSync(join(home, '.claude'), { recursive: true });
  return home;
}

test('installSessionEndHook: creates settings.json from scratch when absent', () => {
  const home = freshHome();
  const r = installSessionEndHook({ home });
  assert.equal(r.replaced, false);
  const settings = JSON.parse(readFileSync(r.path, 'utf8'));
  const cmd = settings.hooks.SessionEnd[0].hooks[0].command;
  assert.ok(cmd.includes(HOOK_SIGNATURE), `expected hook to contain ${HOOK_SIGNATURE}; got ${cmd}`);
});

test('installSessionEndHook: preserves unrelated keys and unrelated hook groups', () => {
  const home = freshHome();
  const settingsPath = join(home, '.claude', 'settings.json');
  writeFileSync(
    settingsPath,
    JSON.stringify({
      theme: 'dark-ansi',
      permissions: { allow: ['Bash(npm test:*)'] },
      hooks: {
        SessionEnd: [
          {
            hooks: [{ type: 'command', command: 'echo other-tool' }],
          },
        ],
        Stop: [
          {
            hooks: [{ type: 'command', command: 'echo other-stop' }],
          },
        ],
      },
    }),
  );

  installSessionEndHook({ home });
  const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
  assert.equal(settings.theme, 'dark-ansi');
  assert.deepEqual(settings.permissions.allow, ['Bash(npm test:*)']);
  // Existing Stop hook untouched
  assert.equal(settings.hooks.Stop[0].hooks[0].command, 'echo other-stop');
  // SessionEnd has both the other tool AND robin
  const allCommands = settings.hooks.SessionEnd.flatMap((g: { hooks: { command: string }[] }) =>
    g.hooks.map((h) => h.command),
  );
  assert.ok(allCommands.some((c: string) => c === 'echo other-tool'));
  assert.ok(allCommands.some((c: string) => c.includes(HOOK_SIGNATURE)));
});

test('installSessionEndHook: idempotent — running twice does not duplicate', () => {
  const home = freshHome();
  installSessionEndHook({ home });
  const second = installSessionEndHook({ home });
  assert.equal(second.replaced, true, 'second install should report replaced=true');

  const settings = JSON.parse(readFileSync(second.path, 'utf8'));
  const robinHooks = settings.hooks.SessionEnd.flatMap((g: { hooks: { command: string }[] }) =>
    g.hooks.filter((h) => h.command.includes(HOOK_SIGNATURE)),
  );
  assert.equal(robinHooks.length, 1, 'should be exactly one Robin hook after re-install');
});

test('installSessionEndHook: updating port replaces the prior entry', () => {
  const home = freshHome();
  installSessionEndHook({ home, port: 41273 });
  installSessionEndHook({ home, port: 41999 });

  const settingsPath = join(home, '.claude', 'settings.json');
  const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
  const allCommands = settings.hooks.SessionEnd.flatMap((g: { hooks: { command: string }[] }) =>
    g.hooks.map((h) => h.command),
  );
  // No stale 41273
  assert.ok(!allCommands.some((c: string) => c.includes(':41273/')));
  assert.ok(allCommands.some((c: string) => c.includes(':41999/')));
});

test('uninstallSessionEndHook: removes Robin entry, preserves others', () => {
  const home = freshHome();
  installSessionEndHook({ home });
  const settingsPath = join(home, '.claude', 'settings.json');
  // Manually add another tool's entry in the same SessionEnd group
  const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
  settings.hooks.SessionEnd.push({
    hooks: [{ type: 'command', command: 'echo unrelated' }],
  });
  writeFileSync(settingsPath, JSON.stringify(settings));

  const r = uninstallSessionEndHook({ home });
  assert.equal(r.replaced, true);

  const after = JSON.parse(readFileSync(settingsPath, 'utf8'));
  const allCommands = (after.hooks?.SessionEnd ?? []).flatMap(
    (g: { hooks: { command: string }[] }) => g.hooks.map((h) => h.command),
  );
  assert.ok(!allCommands.some((c: string) => c.includes(HOOK_SIGNATURE)));
  assert.ok(allCommands.some((c: string) => c === 'echo unrelated'));
});

test('uninstallSessionEndHook: deletes SessionEnd key when no entries remain', () => {
  const home = freshHome();
  installSessionEndHook({ home });
  uninstallSessionEndHook({ home });
  const settingsPath = join(home, '.claude', 'settings.json');
  const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
  assert.equal(settings.hooks?.SessionEnd, undefined);
});

test('uninstallSessionEndHook: noop when settings.json absent', () => {
  const home = freshHome();
  const r = uninstallSessionEndHook({ home });
  assert.equal(r.replaced, false);
});

test('installSessionEndHook: recovers from corrupt JSON by rewriting fresh', () => {
  const home = freshHome();
  const settingsPath = join(home, '.claude', 'settings.json');
  writeFileSync(settingsPath, '{this is not json');
  const r = installSessionEndHook({ home });
  assert.equal(r.replaced, false);
  const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
  assert.ok(settings.hooks.SessionEnd[0].hooks[0].command.includes(HOOK_SIGNATURE));
});

test('robinHookCommand: includes the chosen port and stdin pipe', () => {
  const cmd = robinHookCommand(41999);
  assert.match(cmd, /127\.0\.0\.1:41999/);
  assert.match(cmd, /--data-binary @-/);
});
