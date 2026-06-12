import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  HOOK_SIGNATURE,
  HOOK_SIGNATURE_SESSION_START,
  HOOK_SIGNATURE_USER_PROMPT_SUBMIT,
  installSessionEndHook,
  installSessionStartHook,
  installUserPromptSubmitHook,
  robinHookCommand,
  robinSessionStartHookCommand,
  robinUserPromptSubmitHookCommand,
  uninstallSessionEndHook,
  uninstallSessionStartHook,
  uninstallUserPromptSubmitHook,
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
  // Fail open: a curl timeout/refusal must never surface as a hook error.
  assert.match(cmd, /\|\| true$/);
});

test('all three hook commands short-circuit inside Robin-internal SDK children', () => {
  // runSdk marks its subprocess env with ROBIN_INTERNAL_SDK=1; hook commands
  // inherit that env. Without this guard, every one of Robin's own LLM calls
  // fires SessionEnd → gets captured as a session.captured event (observed
  // live 2026-06-12: 16k+ self-captures of biographer prompts, feedback loop)
  // and SessionStart injects the primer into every internal call (token waste).
  for (const cmd of [
    robinHookCommand(41999),
    robinSessionStartHookCommand(41999),
    robinUserPromptSubmitHookCommand(41999),
  ]) {
    assert.ok(
      cmd.startsWith('[ -z "$ROBIN_INTERNAL_SDK" ] || exit 0; '),
      `internal-SDK guard must lead the command: ${cmd}`,
    );
  }
});

test('robinSessionStartHookCommand: posts to /hooks/session_start with chosen port', () => {
  const cmd = robinSessionStartHookCommand(41999);
  assert.match(cmd, /127\.0\.0\.1:41999/);
  assert.match(cmd, /\/hooks\/session_start/);
  assert.match(cmd, /--data-binary @-/);
  assert.ok(cmd.includes(HOOK_SIGNATURE_SESSION_START));
  assert.match(cmd, /\|\| true$/);
});

test('installSessionStartHook: creates settings.json from scratch when absent', () => {
  const home = freshHome();
  const r = installSessionStartHook({ home });
  assert.equal(r.replaced, false);
  const settings = JSON.parse(readFileSync(r.path, 'utf8'));
  const cmd = settings.hooks.SessionStart[0].hooks[0].command;
  assert.ok(
    cmd.includes(HOOK_SIGNATURE_SESSION_START),
    `expected hook to contain ${HOOK_SIGNATURE_SESSION_START}; got ${cmd}`,
  );
});

test('installSessionStartHook: preserves SessionEnd and third-party SessionStart hooks', () => {
  const home = freshHome();
  // SessionEnd hook present (the sibling lifecycle) — must be untouched.
  installSessionEndHook({ home });
  const settingsPath = join(home, '.claude', 'settings.json');
  const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
  settings.hooks.SessionStart = [{ hooks: [{ type: 'command', command: 'echo other-start' }] }];
  writeFileSync(settingsPath, JSON.stringify(settings));

  installSessionStartHook({ home });
  const after = JSON.parse(readFileSync(settingsPath, 'utf8'));
  // SessionEnd's robin hook still present.
  const endCommands = after.hooks.SessionEnd.flatMap((g: { hooks: { command: string }[] }) =>
    g.hooks.map((h) => h.command),
  );
  assert.ok(endCommands.some((c: string) => c.includes(HOOK_SIGNATURE)));
  // SessionStart has both the third-party hook AND robin's.
  const startCommands = after.hooks.SessionStart.flatMap((g: { hooks: { command: string }[] }) =>
    g.hooks.map((h) => h.command),
  );
  assert.ok(startCommands.some((c: string) => c === 'echo other-start'));
  assert.ok(startCommands.some((c: string) => c.includes(HOOK_SIGNATURE_SESSION_START)));
});

test('installSessionStartHook: idempotent — running twice does not duplicate', () => {
  const home = freshHome();
  installSessionStartHook({ home });
  const second = installSessionStartHook({ home });
  assert.equal(second.replaced, true, 'second install should report replaced=true');

  const settings = JSON.parse(readFileSync(second.path, 'utf8'));
  const robinHooks = settings.hooks.SessionStart.flatMap((g: { hooks: { command: string }[] }) =>
    g.hooks.filter((h) => h.command.includes(HOOK_SIGNATURE_SESSION_START)),
  );
  assert.equal(robinHooks.length, 1, 'should be exactly one Robin hook after re-install');
});

test('installSessionStartHook: updating port replaces the prior entry', () => {
  const home = freshHome();
  installSessionStartHook({ home, port: 41273 });
  installSessionStartHook({ home, port: 41999 });

  const settingsPath = join(home, '.claude', 'settings.json');
  const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
  const allCommands = settings.hooks.SessionStart.flatMap((g: { hooks: { command: string }[] }) =>
    g.hooks.map((h) => h.command),
  );
  assert.ok(!allCommands.some((c: string) => c.includes(':41273/')));
  assert.ok(allCommands.some((c: string) => c.includes(':41999/')));
});

test('uninstallSessionStartHook: removes Robin entry, preserves others', () => {
  const home = freshHome();
  installSessionStartHook({ home });
  const settingsPath = join(home, '.claude', 'settings.json');
  const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
  settings.hooks.SessionStart.push({ hooks: [{ type: 'command', command: 'echo unrelated' }] });
  writeFileSync(settingsPath, JSON.stringify(settings));

  const r = uninstallSessionStartHook({ home });
  assert.equal(r.replaced, true);

  const after = JSON.parse(readFileSync(settingsPath, 'utf8'));
  const allCommands = (after.hooks?.SessionStart ?? []).flatMap(
    (g: { hooks: { command: string }[] }) => g.hooks.map((h) => h.command),
  );
  assert.ok(!allCommands.some((c: string) => c.includes(HOOK_SIGNATURE_SESSION_START)));
  assert.ok(allCommands.some((c: string) => c === 'echo unrelated'));
});

test('uninstallSessionStartHook: deletes SessionStart key when no entries remain', () => {
  const home = freshHome();
  installSessionStartHook({ home });
  uninstallSessionStartHook({ home });
  const settingsPath = join(home, '.claude', 'settings.json');
  const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
  assert.equal(settings.hooks?.SessionStart, undefined);
});

test('uninstallSessionStartHook: noop when settings.json absent', () => {
  const home = freshHome();
  const r = uninstallSessionStartHook({ home });
  assert.equal(r.replaced, false);
});

test('robinUserPromptSubmitHookCommand: posts to /hooks/user_prompt_submit with chosen port', () => {
  const cmd = robinUserPromptSubmitHookCommand(41999);
  assert.match(cmd, /127\.0\.0\.1:41999/);
  assert.match(cmd, /\/hooks\/user_prompt_submit/);
  assert.match(cmd, /--data-binary @-/);
  assert.ok(cmd.includes(HOOK_SIGNATURE_USER_PROMPT_SUBMIT));
  // Runs on every qualifying turn: the timeout must clear the endpoint's real
  // latency (~2.3s under recall load), and it must fail open on a slow daemon.
  assert.match(cmd, /--max-time 5\b/);
  assert.match(cmd, /\|\| true$/);
});

test('installUserPromptSubmitHook: creates settings.json from scratch when absent', () => {
  const home = freshHome();
  const r = installUserPromptSubmitHook({ home });
  assert.equal(r.replaced, false);
  const settings = JSON.parse(readFileSync(r.path, 'utf8'));
  const cmd = settings.hooks.UserPromptSubmit[0].hooks[0].command;
  assert.ok(
    cmd.includes(HOOK_SIGNATURE_USER_PROMPT_SUBMIT),
    `expected hook to contain ${HOOK_SIGNATURE_USER_PROMPT_SUBMIT}; got ${cmd}`,
  );
});

test('installUserPromptSubmitHook: preserves SessionEnd/SessionStart and third-party hooks', () => {
  const home = freshHome();
  installSessionEndHook({ home });
  installSessionStartHook({ home });
  const settingsPath = join(home, '.claude', 'settings.json');
  const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
  settings.hooks.UserPromptSubmit = [{ hooks: [{ type: 'command', command: 'echo other-ups' }] }];
  writeFileSync(settingsPath, JSON.stringify(settings));

  installUserPromptSubmitHook({ home });
  const after = JSON.parse(readFileSync(settingsPath, 'utf8'));
  // Sibling lifecycles untouched.
  const endCommands = after.hooks.SessionEnd.flatMap((g: { hooks: { command: string }[] }) =>
    g.hooks.map((h) => h.command),
  );
  assert.ok(endCommands.some((c: string) => c.includes(HOOK_SIGNATURE)));
  const startCommands = after.hooks.SessionStart.flatMap((g: { hooks: { command: string }[] }) =>
    g.hooks.map((h) => h.command),
  );
  assert.ok(startCommands.some((c: string) => c.includes(HOOK_SIGNATURE_SESSION_START)));
  // UserPromptSubmit has both the third-party hook AND robin's.
  const upsCommands = after.hooks.UserPromptSubmit.flatMap((g: { hooks: { command: string }[] }) =>
    g.hooks.map((h) => h.command),
  );
  assert.ok(upsCommands.some((c: string) => c === 'echo other-ups'));
  assert.ok(upsCommands.some((c: string) => c.includes(HOOK_SIGNATURE_USER_PROMPT_SUBMIT)));
});

test('installUserPromptSubmitHook: idempotent — running twice does not duplicate', () => {
  const home = freshHome();
  installUserPromptSubmitHook({ home });
  const second = installUserPromptSubmitHook({ home });
  assert.equal(second.replaced, true, 'second install should report replaced=true');

  const settings = JSON.parse(readFileSync(second.path, 'utf8'));
  const robinHooks = settings.hooks.UserPromptSubmit.flatMap(
    (g: { hooks: { command: string }[] }) =>
      g.hooks.filter((h) => h.command.includes(HOOK_SIGNATURE_USER_PROMPT_SUBMIT)),
  );
  assert.equal(robinHooks.length, 1, 'should be exactly one Robin hook after re-install');
});

test('uninstallUserPromptSubmitHook: removes Robin entry, deletes empty key', () => {
  const home = freshHome();
  installUserPromptSubmitHook({ home });
  const r = uninstallUserPromptSubmitHook({ home });
  assert.equal(r.replaced, true);
  const settings = JSON.parse(readFileSync(r.path, 'utf8'));
  assert.equal(settings.hooks?.UserPromptSubmit, undefined);
});

test('uninstallUserPromptSubmitHook: noop when settings.json absent', () => {
  const home = freshHome();
  const r = uninstallUserPromptSubmitHook({ home });
  assert.equal(r.replaced, false);
});
