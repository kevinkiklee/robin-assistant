import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
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
