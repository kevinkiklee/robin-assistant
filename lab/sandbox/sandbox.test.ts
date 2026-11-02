// lab/sandbox/sandbox.test.ts
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https, { request as namedHttpsRequest } from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, test } from 'node:test';
import { closeDb, openDb } from '../../system/brain/memory/db.ts';
import { resolveUserDataDir } from '../../system/lib/paths.ts';
import { LabIsolationError } from './errors.ts';
import { assertLabModels, installEgressGuard, installPathGuard } from './guards.ts';
import { detectLivePaths } from './live-paths.ts';
import {
  createSandbox,
  createSimClock,
  enterSandbox,
  reopenSandbox,
  type Sandbox,
} from './sandbox.ts';

const sandboxes: Sandbox[] = [];
const mkSandbox = (): Sandbox => {
  const sb = createSandbox();
  sandboxes.push(sb);
  return sb;
};

let cleanup: (() => void)[] = [];
afterEach(() => {
  for (const f of cleanup.reverse()) f();
  cleanup = [];
  for (const sb of sandboxes.splice(0)) sb.dispose();
});

test('path guard: opening a DB under a forbidden root throws before creating it', () => {
  const live = mkdtempSync(join(tmpdir(), 'robin-fake-live-'));
  cleanup.push(installPathGuard([live]));
  const target = join(live, 'state', 'db', 'robin.sqlite');
  assert.throws(() => openDb(target), LabIsolationError);
  assert.equal(existsSync(join(live, 'state')), false);
});

test('path guard: a symlink into the forbidden root is caught', () => {
  const live = mkdtempSync(join(tmpdir(), 'robin-fake-live-'));
  const other = mkdtempSync(join(tmpdir(), 'robin-other-'));
  symlinkSync(live, join(other, 'link'));
  cleanup.push(installPathGuard([live]));
  assert.throws(() => openDb(join(other, 'link', 'robin.sqlite')), LabIsolationError);
});

test('enterSandbox: HOME redirect defuses the user-data pointer fallback', () => {
  const sb = mkSandbox();
  const exit = enterSandbox(sb, createSimClock(Date.parse('2027-01-01T00:00:00Z')));
  cleanup.push(exit);
  assert.equal(resolveUserDataDir(), sb.userDataDir);
  const savedEnv = process.env.ROBIN_USER_DATA_DIR;
  delete process.env.ROBIN_USER_DATA_DIR; // simulate a forgotten env var
  try {
    assert.ok(resolveUserDataDir().startsWith(sb.root), 'fallback must stay inside the sandbox');
  } finally {
    if (savedEnv !== undefined) process.env.ROBIN_USER_DATA_DIR = savedEnv;
  }
});

test('enterSandbox: env is an allowlist (no stray secrets survive)', () => {
  process.env.SOME_SECRET_TOKEN = 'leak';
  cleanup.push(() => delete process.env.SOME_SECRET_TOKEN);
  const sb = mkSandbox();
  cleanup.push(enterSandbox(sb, createSimClock(0)));
  assert.equal(process.env.SOME_SECRET_TOKEN, undefined);
  assert.equal(process.env.TZ, 'America/New_York');
});

test('egress guard: fetch to a non-allowlisted host is refused', async () => {
  cleanup.push(installEgressGuard(['api.anthropic.com']));
  await assert.rejects(
    () => fetch('https://blocked.invalid/api/channels/1/messages'),
    LabIsolationError,
  );
});

test('egress guard: a named node:https import is also refused', () => {
  cleanup.push(installEgressGuard(['api.anthropic.com']));
  assert.throws(() => namedHttpsRequest('https://blocked.invalid/'), LabIsolationError);
});

test('model allowlist: claude-agent is refused', () => {
  assert.throws(
    () =>
      assertLabModels({ roles: { reasoning: { provider: 'claude-agent', model: 'x' } } } as never),
    LabIsolationError,
  );
  assertLabModels({ roles: { reasoning: { provider: 'anthropic', model: 'x' } } } as never);
});

test('enterSandbox: forbids the real pointer target even after HOME is swapped', () => {
  const fakeHome = mkdtempSync(join(tmpdir(), 'robin-fake-home-'));
  const fakeLive = mkdtempSync(join(tmpdir(), 'robin-fake-live-'));
  mkdirSync(join(fakeHome, '.config', 'robin'), { recursive: true });
  writeFileSync(join(fakeHome, '.config', 'robin', 'user-data-dir'), `${fakeLive}\n`);
  // XDG_CONFIG_HOME relocates the pointer file (CI runners set it), so it's cleared
  // too — otherwise the pointer under fakeHome/.config is never the one consulted.
  const saved = ['HOME', 'ROBIN_USER_DATA_DIR', 'XDG_CONFIG_HOME'].map(
    (k) => [k, process.env[k]] as const,
  );
  // Registered first so it runs LAST (cleanup is LIFO) and always restores the real env,
  // even when setup or an assertion below throws.
  cleanup.push(() => {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
  process.env.HOME = fakeHome;
  delete process.env.ROBIN_USER_DATA_DIR;
  delete process.env.XDG_CONFIG_HOME;
  const sb = mkSandbox();
  const exit = enterSandbox(sb, createSimClock(0), {
    repoRoot: mkdtempSync(join(tmpdir(), 'robin-repo-')),
  });
  cleanup.push(exit);
  assert.throws(() => openDb(join(fakeLive, 'state', 'db', 'robin.sqlite')), LabIsolationError);
});

test('model allowlist: a forbidden fallback provider is refused too', () => {
  assert.throws(
    () =>
      assertLabModels({
        roles: { reasoning: { provider: 'anthropic', fallback: { provider: 'claude-agent' } } },
      } as never),
    LabIsolationError,
  );
});

test('egress guard: options-object hosts are checked', () => {
  cleanup.push(installEgressGuard(['api.anthropic.com']));
  assert.throws(
    () => namedHttpsRequest({ hostname: 'blocked.invalid', port: 443 }),
    LabIsolationError,
  );
});

test('enterSandbox: exit() restores process.env exactly', () => {
  const before = { ...process.env };
  const exit = enterSandbox(mkSandbox(), createSimClock(0));
  exit();
  assert.deepEqual({ ...process.env }, before);
});

test('path guard: ".." in the missing tail cannot escape into the forbidden root', () => {
  const live = mkdtempSync(join(tmpdir(), 'robin-fake-live-'));
  const other = mkdtempSync(join(tmpdir(), 'robin-other-'));
  cleanup.push(installPathGuard([live]));
  // other/nope/../../<live>/a.sqlite  ==  <tmp>/<live>/a.sqlite
  const target = `${other}/nope/../../${basename(live)}/a.sqlite`;
  assert.throws(() => openDb(target), LabIsolationError);
});

// Only meaningful where the filesystem folds case (macOS APFS default): there a
// different-case spelling IS the forbidden root. On a case-sensitive filesystem
// (Linux CI) it's a different, harmless directory.
const caseFolds = existsSync(tmpdir().toUpperCase()) && existsSync(tmpdir().toLowerCase());
test('path guard: a different-case spelling of the forbidden root is caught', {
  skip: !caseFolds && 'case-sensitive filesystem',
}, () => {
  const live = mkdtempSync(join(tmpdir(), 'robin-fake-live-'));
  cleanup.push(installPathGuard([live]));
  const shouty = join(tmpdir(), basename(live).toUpperCase(), 'b.sqlite');
  assert.throws(() => openDb(shouty), LabIsolationError);
});

test('egress guard: URL + options overload cannot swap the host', () => {
  cleanup.push(installEgressGuard(['api.anthropic.com']));
  assert.throws(
    () => namedHttpsRequest('https://api.anthropic.com/', { hostname: 'blocked.invalid' }),
    LabIsolationError,
  );
  assert.throws(
    () =>
      namedHttpsRequest('https://api.anthropic.com/', {
        host: 'x',
        port: 9,
        hostname: 'blocked.invalid',
      }),
    LabIsolationError,
  );
});

test('egress guard: lookup / socketPath / createConnection / agent overrides are refused', () => {
  cleanup.push(installEgressGuard(['api.anthropic.com']));
  for (const o of [
    { lookup: () => undefined },
    { socketPath: '/tmp/none.sock' },
    { createConnection: () => undefined },
    { agent: false },
  ]) {
    assert.throws(
      () => namedHttpsRequest('https://api.anthropic.com/', o as never),
      LabIsolationError,
    );
  }
});

test('egress guard: fetch checks String(input), not a spoofed .url', async () => {
  cleanup.push(installEgressGuard(['api.anthropic.com']));
  const spoof = { url: 'https://api.anthropic.com/', toString: () => 'https://blocked.invalid/' };
  await assert.rejects(() => fetch(spoof as never), LabIsolationError);
  await assert.rejects(() => fetch(new Request('https://blocked.invalid/')), LabIsolationError);
});

test('egress guard: an allowlisted host reaches the original (spied, no network)', async () => {
  const seen: string[] = [];
  const origFetch = globalThis.fetch;
  const origRequest = https.request;
  globalThis.fetch = (async (i: unknown) => {
    seen.push(`fetch ${String(i)}`);
    return new Response('ok');
  }) as typeof fetch;
  https.request = ((u: unknown) => {
    seen.push(`https ${String(u)}`);
    return undefined;
  }) as never;
  syncBuiltinESMExports();
  cleanup.push(() => {
    globalThis.fetch = origFetch;
    https.request = origRequest;
    syncBuiltinESMExports();
  });
  cleanup.push(installEgressGuard(['api.anthropic.com']));
  await fetch('https://api.anthropic.com/v1/messages');
  namedHttpsRequest('https://api.anthropic.com/', { method: 'POST' });
  assert.equal(seen.length, 2);
});

test('detectLivePaths: env override, pointer, XDG default and main checkout are all forbidden', () => {
  const fakeHome = mkdtempSync(join(tmpdir(), 'robin-fake-home-'));
  const pointed = mkdtempSync(join(tmpdir(), 'robin-fake-pointed-'));
  const envLive = join(mkdtempSync(join(tmpdir(), 'robin-fake-envlive-')), 'not-created-yet');
  const mainCo = mkdtempSync(join(tmpdir(), 'robin-fake-main-'));
  const worktree = mkdtempSync(join(tmpdir(), 'robin-fake-wt-'));
  mkdirSync(join(mainCo, '.git', 'worktrees', 'wt'), { recursive: true });
  writeFileSync(join(worktree, '.git'), `gitdir: ${join(mainCo, '.git', 'worktrees', 'wt')}\n`);
  mkdirSync(join(fakeHome, '.config', 'robin'), { recursive: true });
  writeFileSync(join(fakeHome, '.config', 'robin', 'user-data-dir'), `${pointed}\n`);
  const prev = { ...process.env };
  cleanup.push(() => {
    for (const k of Object.keys(process.env)) delete process.env[k];
    Object.assign(process.env, prev);
  });
  process.env.HOME = fakeHome;
  delete process.env.XDG_CONFIG_HOME;
  delete process.env.XDG_DATA_HOME;
  process.env.ROBIN_USER_DATA_DIR = envLive;
  const live = detectLivePaths(worktree);
  cleanup.push(installPathGuard(live));
  for (const dir of [
    envLive,
    pointed,
    join(fakeHome, '.local', 'share', 'robin'),
    join(mainCo, 'user-data'),
    join(worktree, 'user-data'),
  ]) {
    assert.throws(() => openDb(join(dir, 'state', 'db', 'robin.sqlite')), LabIsolationError, dir);
  }
});

test('path guard: resolveUserDataDir is guarded too, and unregister removes it', () => {
  const live = mkdtempSync(join(tmpdir(), 'robin-fake-live-'));
  const off = installPathGuard([live]);
  cleanup.push(off);
  const opts = { env: { ROBIN_USER_DATA_DIR: join(live, 'x') }, home: '/nonexistent-home' };
  assert.throws(() => resolveUserDataDir(opts), LabIsolationError);
  off();
  assert.equal(resolveUserDataDir(opts), join(live, 'x'));
});

test('enterSandbox: a failed install restores process.env exactly and rethrows', () => {
  const before = { ...process.env };
  const sb = mkSandbox();
  assert.throws(() =>
    enterSandbox(sb, createSimClock(0), { livePaths: [123 as unknown as string] }),
  );
  assert.deepEqual({ ...process.env }, before);
});

test('enterSandbox: opts.livePaths replaces detectLivePaths', () => {
  const live = mkdtempSync(join(tmpdir(), 'robin-fake-live-'));
  const sb = mkSandbox();
  cleanup.push(enterSandbox(sb, createSimClock(0), { livePaths: [live] }));
  assert.throws(() => openDb(join(live, 'state', 'db', 'robin.sqlite')), LabIsolationError);
});

test('sandbox: exit() is idempotent', () => {
  const sb = mkSandbox();
  const before = process.env.HOME;
  const exit = enterSandbox(sb, createSimClock(0), { livePaths: ['/nonexistent-live'] });
  exit();
  exit();
  assert.equal(process.env.HOME, before);
});

test('sandbox: reopenSandbox rebuilds the same paths; dispose removes the root', () => {
  const sb = createSandbox();
  const again = reopenSandbox(sb.root);
  assert.equal(again.dbPath, sb.dbPath);
  assert.equal(again.env.HOME, sb.env.HOME);
  sb.dispose();
  assert.equal(existsSync(sb.root), false);
  assert.throws(() => reopenSandbox(sb.root), /not a lab sandbox/);
});

test('sandbox: createSandbox({root}) refuses a non-empty root', () => {
  const root = mkdtempSync(join(tmpdir(), 'robin-lab-root-'));
  writeFileSync(join(root, 'stray'), 'x');
  assert.throws(() => createSandbox({ root }), /not empty/);
});

test('sim clock: set() jumps to an absolute time', () => {
  const c = createSimClock(1000);
  c.set(5000);
  assert.equal(c.now(), 5000);
});

test('egress guard: exiting out of order throws instead of reinstalling stale wrappers', () => {
  const offA = installEgressGuard(['a.invalid']);
  const offB = installEgressGuard(['b.invalid']);
  assert.throws(() => offA(), /out of order/);
  offB();
  offA();
});

test('sandbox: a throwing egress undo still restores env and removes the path guard', () => {
  const live = mkdtempSync(join(tmpdir(), 'robin-fake-live-'));
  const sb = mkSandbox();
  const before = process.env.HOME;
  const origFetch = globalThis.fetch;
  const origs = [http.request, http.get, https.request, https.get];
  const exit = enterSandbox(sb, createSimClock(0), { livePaths: [live] });
  const offTop = installEgressGuard(['c.invalid']);
  assert.throws(() => exit(), /out of order/);
  assert.equal(process.env.HOME, before);
  // path guard removed: opening under the former live root no longer throws
  closeDb(openDb(join(live, 'x.sqlite')));
  offTop();
  exit(); // idempotent: no-op
  // the stuck sandbox egress wrappers cannot be unwound; restore the originals by hand
  globalThis.fetch = origFetch;
  [http.request, http.get, https.request, https.get] = origs;
  syncBuiltinESMExports();
});
