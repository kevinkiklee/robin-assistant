import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { installSecretHooks } from '../../../lib/secrets/install.ts';
import { installRuleFile } from '../../../lib/secrets/rule-file.ts';
import { secretsPaths } from '../../../lib/secrets/store.ts';
import { secretsHygieneInvariant } from './secrets-hygiene.ts';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'robin-hygiene-'));
  const home = join(root, 'home');
  const userData = join(root, 'ud');
  const distRoot = join(root, 'dist');
  const hooks = join(distRoot, 'lib', 'secrets', 'hooks');
  mkdirSync(hooks, { recursive: true });
  writeFileSync(join(hooks, 'guard.js'), '');
  writeFileSync(join(hooks, 'post-tool.js'), '');
  const sp = secretsPaths(userData);
  mkdirSync(join(userData, 'config', 'secrets'), { recursive: true });
  mkdirSync(join(userData, 'state', 'runtime'), { recursive: true });
  writeFileSync(sp.vault, 'spk_test_NAME=x\n', { mode: 0o600 });
  chmodSync(sp.vault, 0o600);
  const nodeBin = process.execPath;
  installSecretHooks({ home, userData, distRoot, nodeBin });
  installRuleFile(home);
  const inv = (env: NodeJS.ProcessEnv = {}, nowMs?: () => number) =>
    secretsHygieneInvariant({ userData, home, env, nodeBin, distRoot, nowMs });
  return { root, home, userData, distRoot, sp, inv };
}

test('all good is ok', async () => {
  const f = fixture();
  assert.deepEqual(await f.inv().check(), { ok: true });
});

test('a 0644 backup fails, naming it; repair fixes', async () => {
  const f = fixture();
  const bak = `${f.sp.vault}.bak-20261113T010101`;
  writeFileSync(bak, 'x\n', { mode: 0o644 });
  chmodSync(bak, 0o644);
  const r = await f.inv().check();
  assert.equal(r.ok, false);
  assert.match(r.message ?? '', /vault\.env\.bak-20261113T010101/);
  await f.inv().repair?.();
  assert.equal(statSync(bak).mode & 0o777, 0o600);
  assert.equal((await f.inv().check()).ok, true);
});

test('recorded env-local target and its backup must be 0600', async () => {
  const f = fixture();
  const dir = join(f.root, 'proj');
  mkdirSync(dir);
  const target = join(dir, '.env.local');
  writeFileSync(target, 'A=1\n');
  chmodSync(target, 0o644);
  writeFileSync(`${target}.bak-20261113T010101`, 'A=0\n');
  chmodSync(`${target}.bak-20261113T010101`, 0o644);
  writeFileSync(
    f.sp.deliveries,
    JSON.stringify({ NAME: [{ kind: 'env-local', path: target, var: 'NAME' }] }),
  );
  const r = await f.inv().check();
  assert.equal(r.ok, false);
  assert.match(r.message ?? '', /\.env\.local is not mode/);
  assert.match(r.message ?? '', /\.env\.local\.bak-/);
  await f.inv().repair?.();
  assert.equal((await f.inv().check()).ok, true);
});

test('corrupt delivery registry is reported, not thrown', async () => {
  const f = fixture();
  writeFileSync(f.sp.deliveries, '{nope');
  const r = await f.inv().check();
  assert.equal(r.ok, false);
  assert.match(r.message ?? '', /delivery registry/);
});

test('missing hooks and rule file fail; repair restores them', async () => {
  const f = fixture();
  rmSync(join(f.home, '.claude', 'settings.json'));
  rmSync(join(f.home, '.claude', 'rules', 'secrets.md'));
  const r = await f.inv().check();
  assert.equal(r.ok, false);
  assert.match(r.message ?? '', /PreToolUse hook missing/);
  assert.match(r.message ?? '', /rule file/);
  await f.inv().repair?.();
  assert.equal((await f.inv().check()).ok, true);
});

test('missing hook script or node binary fails', async () => {
  const f = fixture();
  rmSync(join(f.distRoot, 'lib', 'secrets', 'hooks', 'post-tool.js'));
  let r = await f.inv().check();
  assert.equal(r.ok, false);
  assert.match(r.message ?? '', /post-tool\.js.*does not exist/);
  assert.match(r.message ?? '', /pnpm build/);

  const g = fixture();
  const s = join(g.home, '.claude', 'settings.json');
  writeFileSync(s, readFileSync(s, 'utf8').replaceAll(process.execPath, '/nonexistent/node-gone'));
  r = await g.inv().check();
  assert.equal(r.ok, false);
  assert.match(r.message ?? '', /\/nonexistent\/node-gone/);
  await g.inv().repair?.();
  assert.equal((await g.inv().check()).ok, true);
});

test('stale window and stale op fail', async () => {
  const f = fixture();
  const past = new Date(Date.now() - 5_000).toISOString();
  writeFileSync(
    f.sp.window,
    JSON.stringify({
      sessionId: 's',
      tabId: 1,
      provider: 'acme',
      name: 'NAME',
      scriptHashes: [],
      clipboardHashAtArm: 'h',
      openedAt: past,
      expiresAt: past,
      status: 'open',
    }),
  );
  writeFileSync(
    f.sp.op,
    JSON.stringify({
      provider: 'acme',
      name: 'NAME',
      mode: 'create',
      targets: [],
      startedAt: new Date(Date.now() - 2 * 3_600_000).toISOString(),
    }),
  );
  const r = await f.inv().check();
  assert.equal(r.ok, false);
  assert.match(r.message ?? '', /stale key window/);
  assert.match(r.message ?? '', /stale pending op/);
});

test('invalid window file is reported, not thrown', async () => {
  const f = fixture();
  writeFileSync(f.sp.window, '{"nope":1}');
  const r = await f.inv().check();
  assert.equal(r.ok, false);
  assert.match(r.message ?? '', /invalid window file/);
});

test('telemetry env fails and repair never touches it', async () => {
  const f = fixture();
  const inv = f.inv({ CLAUDE_CODE_ENABLE_TELEMETRY: '1' });
  const r = await inv.check();
  assert.equal(r.ok, false);
  assert.match(r.message ?? '', /CLAUDE_CODE_ENABLE_TELEMETRY/);
  await inv.repair?.();
  assert.equal((await inv.check()).ok, false);
});

test('OTEL_* in settings.json env fails and survives repair', async () => {
  const f = fixture();
  const s = join(f.home, '.claude', 'settings.json');
  const cur = JSON.parse(readFileSync(s, 'utf8'));
  cur.env = { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://example.invalid' };
  writeFileSync(s, JSON.stringify(cur));
  const r = await f.inv().check();
  assert.equal(r.ok, false);
  assert.match(r.message ?? '', /OTEL_EXPORTER_OTLP_ENDPOINT/);
  await f.inv().repair?.();
  assert.ok(JSON.parse(readFileSync(s, 'utf8')).env.OTEL_EXPORTER_OTLP_ENDPOINT);
  assert.equal((await f.inv().check()).ok, false);
});

test('not set up: check ok, repair does nothing', async () => {
  const root = mkdtempSync(join(tmpdir(), 'robin-hygiene-'));
  const home = join(root, 'home');
  const userData = join(root, 'ud');
  mkdirSync(userData, { recursive: true });
  const inv = secretsHygieneInvariant({ userData, home, env: {} });
  const r = await inv.check();
  assert.equal(r.ok, true);
  assert.match(r.message ?? '', /not set up/);
  await inv.repair?.();
  assert.equal(existsSync(join(home, '.claude')), false);
});

test('rule file alone counts as set up', async () => {
  const root = mkdtempSync(join(tmpdir(), 'robin-hygiene-'));
  const home = join(root, 'home');
  installRuleFile(home);
  const inv = secretsHygieneInvariant({ userData: join(root, 'ud'), home, env: {} });
  const r = await inv.check();
  assert.equal(r.ok, false);
  assert.match(r.message ?? '', /hook missing/);
});

test('null hook group in settings does not throw', async () => {
  const f = fixture();
  const s = join(f.home, '.claude', 'settings.json');
  const cur = JSON.parse(readFileSync(s, 'utf8'));
  cur.hooks.PreToolUse.push(null, { hooks: null }, { hooks: [null] });
  writeFileSync(s, JSON.stringify(cur));
  assert.equal((await f.inv().check()).ok, true);
});

test('a stat failure is reported, not thrown', async () => {
  const f = fixture();
  const dir = join(f.root, 'locked');
  mkdirSync(dir);
  const target = join(dir, 'k.key');
  writeFileSync(target, 'x', { mode: 0o600 });
  writeFileSync(f.sp.deliveries, JSON.stringify({ N: [{ kind: 'secret-file', path: target }] }));
  chmodSync(dir, 0o000);
  try {
    const r = await f.inv().check();
    assert.equal(r.ok, true); // existsSync false under a locked dir: skipped, no throw
  } finally {
    chmodSync(dir, 0o700);
  }
  // Corrupt top-level shape: whole-check guard
  writeFileSync(f.sp.deliveries, JSON.stringify({ N: 5 }));
  const r2 = await f.inv().check();
  assert.equal(typeof r2.ok, 'boolean');
});

test('saved window past expiry says left over', async () => {
  const f = fixture();
  const past = new Date(Date.now() - 5_000).toISOString();
  writeFileSync(
    f.sp.window,
    JSON.stringify({
      sessionId: 's',
      tabId: 1,
      provider: 'acme',
      name: 'NAME',
      scriptHashes: [],
      clipboardHashAtArm: 'h',
      openedAt: past,
      expiresAt: past,
      status: 'saved',
    }),
  );
  const r = await f.inv().check();
  assert.match(r.message ?? '', /left over/);
  assert.doesNotMatch(r.message ?? '', /stale key window/);
});

test('symlinked backup is reported and never chmod-ed', async () => {
  const f = fixture();
  const outside = join(f.root, 'outside.txt');
  writeFileSync(outside, 'x', { mode: 0o644 });
  chmodSync(outside, 0o644);
  symlinkSync(outside, `${f.sp.vault}.bak-20261113T010101`);
  const r = await f.inv().check();
  assert.match(r.message ?? '', /symlinked backup .*vault\.env\.bak-/);
  await f.inv().repair?.();
  assert.equal(statSync(outside).mode & 0o777, 0o644);
});

test('unrecognized secret hook command is a problem', async () => {
  const f = fixture();
  const s = join(f.home, '.claude', 'settings.json');
  const cur = JSON.parse(readFileSync(s, 'utf8'));
  cur.hooks.PostToolUse = [
    { hooks: [{ type: 'command', command: 'echo something /lib/secrets/hooks/post-tool.js' }] },
  ];
  writeFileSync(s, JSON.stringify(cur));
  const r = await f.inv().check();
  assert.match(r.message ?? '', /unrecognized secret hook command/);
});

test('redact-files entries the hook skips are reported by path', async () => {
  const f = fixture();
  const dir = join(f.root, 'a-dir');
  mkdirSync(dir);
  const locked = join(f.root, 'locked.key');
  writeFileSync(locked, 'spk_test_locked_value_00001\n');
  chmodSync(locked, 0o000);
  const fine = join(f.root, 'fine.key');
  writeFileSync(fine, 'spk_test_fine_value_0000001\n');
  writeFileSync(f.sp.redactFiles, `${dir}\n${locked}\n${fine}\n${join(f.root, 'gone')}\n`);
  try {
    const r = await f.inv().check();
    assert.equal(r.ok, false);
    const m = r.message ?? '';
    assert.match(
      m,
      /locked\.key \(listed in .*redact-files\.txt\) is skipped by redaction: unreadable \(EACCES\)/,
    );
    assert.match(m, /gone \(listed in .*\) is skipped by redaction: missing \(ENOENT\)/);
    assert.doesNotMatch(m, /fine\.key|a-dir/);
  } finally {
    chmodSync(locked, 0o600);
  }
});

test('an unreadable redact-files list is reported', async () => {
  const f = fixture();
  mkdirSync(f.sp.redactFiles);
  const r = await f.inv().check();
  assert.match(
    r.message ?? '',
    /redaction source .*redact-files\.txt can't be read \(EISDIR\), so the redaction hook withholds all output — fix it/,
  );
});

test('a listed redaction source that throws is named, not the whole list', async () => {
  const f = fixture();
  const plain = join(f.root, 'plain');
  writeFileSync(plain, 'x\n');
  const child = join(plain, 'child');
  writeFileSync(f.sp.redactFiles, `${child}\n`);
  const m = (await f.inv().check()).message ?? '';
  assert.ok(
    m.includes(
      `redaction source ${child} can't be read (ENOTDIR), so the redaction hook withholds all output — fix or remove it from redact-files.txt`,
    ),
    m,
  );
  assert.doesNotMatch(m, /is unreadable, so/);
});

test('repair leaves settings.json alone when the hooks are fine (N5)', async () => {
  const f = fixture();
  const s = join(f.home, '.claude', 'settings.json');
  const compact = JSON.stringify({ ...JSON.parse(readFileSync(s, 'utf8')), theme: 'dark' });
  writeFileSync(s, compact);
  const bak = `${f.sp.vault}.bak-20261113T010101`;
  writeFileSync(bak, 'x\n');
  chmodSync(bak, 0o644);
  assert.equal((await f.inv().check()).ok, false);
  await f.inv().repair?.();
  assert.equal(readFileSync(s, 'utf8'), compact);
  assert.equal(statSync(bak).mode & 0o777, 0o600);
  assert.equal((await f.inv().check()).ok, true);
});

interface RawSettings {
  hooks: Record<
    string,
    { matcher?: string; hooks: { command: string; timeout?: number; onFailure?: string }[] }[]
  >;
}

function editSettings(f: ReturnType<typeof fixture>, fn: (s: RawSettings) => void): string {
  const p = join(f.home, '.claude', 'settings.json');
  const cur = JSON.parse(readFileSync(p, 'utf8')) as RawSettings;
  fn(cur);
  writeFileSync(p, JSON.stringify(cur, null, 2));
  return p;
}

test('a PreToolUse entry missing onFailure: block is flagged and repaired', async () => {
  const f = fixture();
  const p = editSettings(f, (s) => {
    delete s.hooks.PreToolUse[0].hooks[0].onFailure;
  });
  const r = await f.inv().check();
  assert.equal(r.ok, false);
  assert.match(
    r.message ?? '',
    /secret PreToolUse hook .* differs from what install writes \(onFailure\)/,
  );
  await f.inv().repair?.();
  assert.equal(JSON.parse(readFileSync(p, 'utf8')).hooks.PreToolUse[0].hooks[0].onFailure, 'block');
  assert.deepEqual(await f.inv().check(), { ok: true });
});

test('a changed matcher, timeout or command is flagged and repaired', async () => {
  const f = fixture();
  editSettings(f, (s) => {
    s.hooks.PostToolUse[0].matcher = 'Bash';
    s.hooks.PostToolUse[0].hooks[0].timeout = 60;
    s.hooks.PreToolUse[0].hooks[0].command = s.hooks.PreToolUse[0].hooks[0].command.replace(
      ' || { echo',
      ' ; true || { echo',
    );
  });
  const m = (await f.inv().check()).message ?? '';
  assert.match(m, /PostToolUse hook .* \(matcher, timeout\)/);
  assert.match(m, /PreToolUse hook .* \(command\)/);
  await f.inv().repair?.();
  assert.deepEqual(await f.inv().check(), { ok: true });
});

test('repair for a stale window only never rewrites settings.json', async () => {
  const f = fixture();
  const s = join(f.home, '.claude', 'settings.json');
  const past = new Date(Date.now() - 5_000).toISOString();
  writeFileSync(
    f.sp.window,
    JSON.stringify({
      sessionId: 's',
      tabId: 1,
      provider: 'acme',
      name: 'NAME',
      scriptHashes: [],
      clipboardHashAtArm: 'h',
      openedAt: past,
      expiresAt: past,
      status: 'open',
    }),
  );
  const before = statSync(s).mtimeMs;
  const bytes = readFileSync(s, 'utf8');
  assert.equal((await f.inv().check()).ok, false);
  await new Promise((r) => setTimeout(r, 20));
  await f.inv().repair?.();
  assert.equal(statSync(s).mtimeMs, before);
  assert.equal(readFileSync(s, 'utf8'), bytes);
});
