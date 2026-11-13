import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setOperatorProfileForTests } from '../operator-profile.ts';
import {
  installSecretHooks,
  SECRET_HOOK_SIGNATURE,
  secretGuardCommand,
  secretPostToolCommand,
  uninstallSecretHooks,
} from './install.ts';
import { installRuleFile, RULE_FILE_TEXT, uninstallRuleFile } from './rule-file.ts';

const UNRELATED_PRE = {
  matcher: 'Bash',
  hooks: [{ type: 'command', command: '~/.claude/hooks/some-other-guard.sh', timeout: 5 }],
};
const SESSION_END = {
  hooks: [
    {
      type: 'command',
      command:
        'curl -s --max-time 5 -X POST http://127.0.0.1:41273/hooks/session_end --data-binary @- || true',
      timeout: 10,
    },
  ],
};

interface Fixture {
  home: string;
  userData: string;
  distRoot: string;
  settingsPath: string;
}

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'robin-secret-install-'));
  const home = join(root, 'home');
  const userData = join(root, 'user-data');
  const distRoot = join(root, 'dist');
  mkdirSync(join(home, '.claude'), { recursive: true });
  mkdirSync(userData, { recursive: true });
  const settingsPath = join(home, '.claude', 'settings.json');
  writeFileSync(
    settingsPath,
    JSON.stringify(
      { model: 'x', hooks: { PreToolUse: [UNRELATED_PRE], SessionEnd: [SESSION_END] } },
      null,
      2,
    ),
  );
  return { home, userData, distRoot, settingsPath };
}

function opts(f: Fixture) {
  return { home: f.home, userData: f.userData, distRoot: f.distRoot, nodeBin: '/usr/bin/false' };
}

interface Group {
  matcher?: string;
  hooks: { type: string; command: string; timeout?: number }[];
}
function settings(f: Fixture): { model: string; hooks: Record<string, Group[]> } {
  return JSON.parse(readFileSync(f.settingsPath, 'utf8'));
}
const isSecret = (g: Group) => g.hooks.some((h) => h.command.includes(SECRET_HOOK_SIGNATURE));

test('install: adds both groups, keeps unrelated hooks byte-for-byte', () => {
  const f = fixture();
  const r = installSecretHooks(opts(f));
  assert.equal(r.path, f.settingsPath);
  assert.equal(r.replaced, false);
  const s = settings(f);
  assert.equal(s.model, 'x');
  assert.deepEqual(s.hooks.SessionEnd, [SESSION_END]);
  assert.equal(JSON.stringify(s.hooks.PreToolUse[0]), JSON.stringify(UNRELATED_PRE));
  assert.equal(s.hooks.PreToolUse.length, 2);
  assert.deepEqual(s.hooks.PreToolUse[1], {
    matcher: '.*',
    hooks: [{ type: 'command', command: secretGuardCommand(opts(f)), timeout: 10 }],
  });
  assert.deepEqual(s.hooks.PostToolUse, [
    {
      matcher: '.*',
      hooks: [{ type: 'command', command: secretPostToolCommand(opts(f)), timeout: 10 }],
    },
  ]);
});

test('install: pins ROBIN_USER_DATA_DIR in both commands', () => {
  const f = fixture();
  assert.ok(secretGuardCommand(opts(f)).includes(`ROBIN_USER_DATA_DIR='${f.userData}'`));
  assert.ok(secretPostToolCommand(opts(f)).includes(`ROBIN_USER_DATA_DIR='${f.userData}'`));
  assert.ok(secretGuardCommand(opts(f)).includes(`'${f.distRoot}/lib/secrets/hooks/guard.js'`));
  assert.ok(
    secretPostToolCommand(opts(f)).includes(`'${f.distRoot}/lib/secrets/hooks/post-tool.js'`),
  );
});

test('install twice: replaced true, no duplicate groups', () => {
  const f = fixture();
  installSecretHooks(opts(f));
  const r = installSecretHooks(opts(f));
  assert.equal(r.replaced, true);
  const s = settings(f);
  assert.equal(s.hooks.PreToolUse.filter(isSecret).length, 1);
  assert.equal(s.hooks.PostToolUse.filter(isSecret).length, 1);
  assert.equal(s.hooks.PreToolUse.length, 2);
});

test('install: warns when the compiled guard is missing, silent when present', () => {
  const f = fixture();
  assert.match(installSecretHooks(opts(f)).warning ?? '', /run pnpm build/);
  mkdirSync(join(f.distRoot, 'lib', 'secrets', 'hooks'), { recursive: true });
  writeFileSync(join(f.distRoot, 'lib', 'secrets', 'hooks', 'guard.js'), '');
  assert.equal(installSecretHooks(opts(f)).warning, undefined);
});

test('install: refuses paths with a quote, newline or $', () => {
  for (const bad of ["/tmp/it's", '/tmp/a\nb', '/tmp/$HOME']) {
    const f = fixture();
    const before = readFileSync(f.settingsPath, 'utf8');
    assert.throws(() => installSecretHooks({ ...opts(f), userData: bad }));
    assert.throws(() => installSecretHooks({ ...opts(f), nodeBin: bad }));
    assert.throws(() => installSecretHooks({ ...opts(f), distRoot: bad }));
    assert.equal(readFileSync(f.settingsPath, 'utf8'), before);
  }
});

test('install: corrupt settings.json is refused, not overwritten', () => {
  const f = fixture();
  writeFileSync(f.settingsPath, '{ not json');
  assert.throws(() => installSecretHooks(opts(f)));
  assert.equal(readFileSync(f.settingsPath, 'utf8'), '{ not json');
});

test('install: no settings.json yet creates it', () => {
  const root = mkdtempSync(join(tmpdir(), 'robin-secret-install-'));
  const r = installSecretHooks({
    home: root,
    userData: join(root, 'u'),
    distRoot: join(root, 'd'),
    nodeBin: '/usr/bin/false',
  });
  const s = JSON.parse(readFileSync(r.path, 'utf8'));
  assert.equal(s.hooks.PreToolUse.length, 1);
  assert.equal(s.hooks.PostToolUse.length, 1);
});

test('uninstall: removes only secret groups', () => {
  const f = fixture();
  installSecretHooks(opts(f));
  const r = uninstallSecretHooks({ home: f.home });
  assert.equal(r.replaced, true);
  const s = settings(f);
  assert.deepEqual(s.hooks.PreToolUse, [UNRELATED_PRE]);
  assert.equal(s.hooks.PostToolUse, undefined);
  assert.deepEqual(s.hooks.SessionEnd, [SESSION_END]);
  assert.equal(s.model, 'x');
  assert.equal(uninstallSecretHooks({ home: f.home }).replaced, false);
});

/** A stub hook script: copies stdin to stdout and drops a marker file. */
function stubDist(f: Fixture, body: string): string {
  const dir = join(f.distRoot, 'lib', 'secrets', 'hooks');
  mkdirSync(dir, { recursive: true });
  const marker = join(f.distRoot, 'ran');
  writeFileSync(join(dir, 'guard.js'), body.replace('MARKER', JSON.stringify(marker)));
  return marker;
}

// Dynamic import works whether the temp dir resolves the stub as CJS or ESM.
const ECHO_STUB = `
import('node:fs').then((fs) => {
  fs.writeFileSync(MARKER, process.env.ROBIN_USER_DATA_DIR ?? '');
  process.stdout.write(fs.readFileSync(0));
});
`;

function runCommand(f: Fixture, input: string): ReturnType<typeof spawnSync> {
  const cmd = secretGuardCommand({ ...opts(f), nodeBin: process.execPath });
  return spawnSync('/bin/sh', ['-c', cmd], { input, encoding: 'utf8' });
}

test('guard command: re-feeds stdin byte-for-byte when a window exists', () => {
  const f = fixture();
  const marker = stubDist(f, ECHO_STUB);
  mkdirSync(join(f.userData, 'state', 'runtime'), { recursive: true });
  writeFileSync(join(f.userData, 'state', 'runtime', 'secret-window.json'), '{}');
  const input = `${JSON.stringify({ tool_name: 'Bash', tool_input: { command: "echo 'a  b' $X" } })}\n\n`;
  const r = runCommand(f, input);
  assert.equal(r.status, 0, String(r.stderr));
  assert.equal(r.stdout, input);
  assert.equal(readFileSync(marker, 'utf8'), f.userData);
});

test('guard command: no window and not arm → exits 0 without running node', () => {
  const f = fixture();
  const marker = stubDist(f, ECHO_STUB);
  const r = runCommand(f, JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls' } }));
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  assert.equal(existsSync(marker), false);
});

test('guard command: no window but an arm call reaches node', () => {
  const f = fixture();
  const marker = stubDist(f, ECHO_STUB);
  const input = JSON.stringify({
    tool_name: 'Bash',
    tool_input: { command: 'robin secret arm --tab 7' },
  });
  const r = runCommand(f, input);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, input);
  assert.equal(existsSync(marker), true);
});

test('guard command: a node failure becomes a blocking exit 2', () => {
  const f = fixture();
  stubDist(f, 'process.exit(1);');
  mkdirSync(join(f.userData, 'state', 'runtime'), { recursive: true });
  writeFileSync(join(f.userData, 'state', 'runtime', 'secret-window.json'), '{}');
  const r = runCommand(f, '{}');
  assert.equal(r.status, 2);
  assert.match(String(r.stderr), /secret guard failed/);
});

test('guard command: a missing guard.js with a window open blocks (exit 2)', () => {
  const f = fixture();
  mkdirSync(join(f.userData, 'state', 'runtime'), { recursive: true });
  writeFileSync(join(f.userData, 'state', 'runtime', 'secret-window.json'), '{}');
  const r = runCommand(f, '{}');
  assert.equal(r.status, 2);
});

test('installRuleFile writes RULE_FILE_TEXT with the operator filled in', () => {
  const root = mkdtempSync(join(tmpdir(), 'robin-secret-rule-'));
  setOperatorProfileForTests({
    name: 'Sam Rivera',
    context: null,
    aliases: [],
    privateTerms: [],
    home: null,
  });
  try {
    const path = installRuleFile(root);
    assert.equal(path, join(root, '.claude', 'rules', 'secrets.md'));
    const text = readFileSync(path, 'utf8');
    assert.equal(text, RULE_FILE_TEXT.replaceAll('{{operator}}', 'Sam Rivera'));
    assert.ok(!text.includes('{{operator}}'));
    assert.match(text, /Never ask Sam Rivera to paste a key/);
    assert.match(text, /robin secret pipe <NAME> -- <cmd>/);
    assert.ok(!text.includes('--confirmed'));
    assert.equal(uninstallRuleFile(root), true);
    assert.equal(existsSync(path), false);
    assert.equal(uninstallRuleFile(root), false);
  } finally {
    setOperatorProfileForTests(null);
  }
});

test('RULE_FILE_TEXT is a template: placeholder, no --confirmed, the new rules', () => {
  assert.ok(RULE_FILE_TEXT.startsWith('# Secrets: use `robin secret`, never chat\n'));
  assert.ok(RULE_FILE_TEXT.includes('{{operator}}'));
  assert.ok(RULE_FILE_TEXT.includes('Never use `robin secret exec` to send a key'));
  assert.ok(RULE_FILE_TEXT.includes('Never click, type into, or dismiss'));
  assert.ok(RULE_FILE_TEXT.includes('Bash timeout hint'));
});
