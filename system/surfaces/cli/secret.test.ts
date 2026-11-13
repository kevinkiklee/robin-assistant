import assert from 'node:assert/strict';
import type { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { ClipboardIO } from '../../lib/secrets/clipboard.ts';
import { readDeliveries } from '../../lib/secrets/deliveries.ts';
import { cloudflare } from '../../lib/secrets/recipes/cloudflare.ts';
import { linear } from '../../lib/secrets/recipes/linear.ts';
import { getMaster, secretsPaths, setMaster } from '../../lib/secrets/store.ts';
import {
  readOp,
  readWindow,
  writeArmSession,
  writeOp,
  writeWindow,
} from '../../lib/secrets/window.ts';
import {
  appleScriptString,
  beginLines,
  confirmScript,
  dialogWord,
  macConfirmWith,
  runSecretCommand,
  type SecretDeps,
} from './secret.ts';

const VALUE = 'spk_test_abcdEFGH1234ijklMNOP5678';
const OTHER = 'spk_test_zyxwVUTS9876rqpoNMLK9999';
const NOW = new Date('2026-11-13T15:00:00.000Z');

interface Harness {
  deps: Partial<SecretDeps>;
  userData: string;
  root: string;
  lines: string[];
  clip: { text: string; cleared: number; notes: string[] };
  spawned: string[][];
  restarts: number;
  /** What the stubbed operator dialog answers (true = "Send"). */
  approve: boolean;
  confirms: { title: string; body: string }[];
  output(): string;
}

function harness(over: Partial<SecretDeps> = {}): Harness {
  const root = mkdtempSync(join(tmpdir(), 'robin-secret-cli-'));
  const userData = join(root, 'user-data');
  mkdirSync(userData, { recursive: true });
  const lines: string[] = [];
  const clip = { text: 'something the operator copied earlier', cleared: 0, notes: [] as string[] };
  const clipboard: ClipboardIO = {
    read: () => clip.text,
    clear: () => {
      clip.text = '';
      clip.cleared++;
    },
    notify: (_t, body) => {
      clip.notes.push(body);
    },
  };
  const spawned: string[][] = [];
  const spawn = ((cmd: string, args: string[]) => {
    spawned.push([cmd, ...args]);
    return { status: 0 };
  }) as unknown as typeof spawnSync;
  const h: Harness = {
    userData,
    root,
    lines,
    clip,
    spawned,
    restarts: 0,
    approve: false,
    confirms: [],
    deps: {},
    output: () => lines.join('\n'),
  };
  h.deps = {
    userData,
    clipboard,
    env: {},
    launchctlGetenv: () => undefined,
    git: () => ({ status: 128, stdout: '', stderr: 'fatal: not a git repository' }),
    spawn,
    now: () => NOW,
    out: (s: string) => {
      lines.push(s);
    },
    restartDaemon: async () => {
      h.restarts++;
      return true;
    },
    sleep: async () => {},
    readStdin: async () => `${VALUE}\n`,
    confirm: (title: string, body: string) => {
      h.confirms.push({ title, body });
      return h.approve;
    },
    ...over,
  };
  return h;
}

const run = (h: Harness, args: string[]) => runSecretCommand(args, h.deps);

/** begin (manual provider) → arm-session record → arm → the key is "copied". */
async function openWindow(h: Harness, name = 'SPK_TEST_KEY', begin: string[] = []): Promise<void> {
  assert.equal(await run(h, ['begin', 'acme', name, ...begin]), 0);
  writeArmSession(h.userData, { sessionId: 'sess-1', tabId: 7, at: NOW.toISOString() });
  assert.equal(await run(h, ['arm', '--tab', '7']), 0);
}

test('set: refuses when the clipboard is unchanged since arm', async () => {
  const h = harness();
  await openWindow(h);
  const code = await run(h, ['set', 'SPK_TEST_KEY', '--from-clipboard']);
  assert.equal(code, 1);
  assert.match(h.output(), /hasn't changed since arm/);
  assert.equal(getMaster(h.userData, 'SPK_TEST_KEY'), undefined);
  assert.equal(readWindow(h.userData)?.status, 'open');
});

test('set: saves, delivers to --to .env.local, clears clipboard, prints fingerprint only', async () => {
  const h = harness();
  await openWindow(h);
  h.clip.text = `${VALUE}\n`;
  const envLocal = join(h.root, 'proj', '.env.local');
  mkdirSync(join(h.root, 'proj'));
  const code = await run(h, ['set', 'SPK_TEST_KEY', '--to', envLocal, '--as', 'APP_KEY']);
  assert.equal(code, 0);
  assert.equal(getMaster(h.userData, 'SPK_TEST_KEY'), VALUE);
  assert.match(readFileSync(envLocal, 'utf8'), new RegExp(`^APP_KEY=${VALUE}$`, 'm'));
  assert.equal(statSync(envLocal).mode & 0o777, 0o600);
  assert.equal(h.clip.cleared, 1);
  assert.equal(h.clip.text, '');
  assert.equal(readWindow(h.userData)?.status, 'saved');
  assert.equal(readOp(h.userData), null);
  assert.deepEqual(readDeliveries(h.userData).SPK_TEST_KEY, [
    { kind: 'env-local', path: envLocal, var: 'APP_KEY' },
  ]);
  const out = h.output();
  assert.match(out, /SPK_TEST_KEY …5678 \(33\) · saved/);
  assert.match(out, /delivered: 1 files/);
  assert.match(out, /next: close the tab/);
  assert.doesNotMatch(out, /then: robin secret restart/);
  assert.ok(!out.includes(VALUE));
  const log = readFileSync(secretsPaths(h.userData).log, 'utf8');
  assert.ok(!log.includes(VALUE));
  assert.match(log, /"op":"set"/);
});

test('set --get same value: already current, nothing written', async () => {
  const h = harness();
  setMaster(h.userData, 'SPK_TEST_KEY', VALUE);
  const vault = secretsPaths(h.userData).vault;
  const before = statSync(vault).mtimeMs;
  await openWindow(h, 'SPK_TEST_KEY', ['--get']);
  h.clip.text = VALUE;
  const code = await run(h, ['set', 'SPK_TEST_KEY']);
  assert.equal(code, 0);
  assert.match(h.output(), /SPK_TEST_KEY …5678 \(33\) · already current/);
  assert.match(h.output(), /delivered: 0 files/);
  assert.equal(statSync(vault).mtimeMs, before);
  assert.equal(h.clip.cleared, 1);
});

test('set: refuses a name shadowed by the shell', async () => {
  const h = harness({ env: { SPK_TEST_KEY: 'from the shell' } });
  await openWindow(h);
  h.clip.text = VALUE;
  const envLocal = join(h.root, '.env.local');
  const code = await run(h, ['set', 'SPK_TEST_KEY', '--to', envLocal]);
  assert.equal(code, 2);
  assert.match(h.output(), /shell environment/);
  assert.equal(getMaster(h.userData, 'SPK_TEST_KEY'), undefined);
  assert.equal(existsSync(envLocal), false);
  assert.equal(h.clip.cleared, 0);
});

test('set: refuses an un-ignored --to inside a repo, writes nothing', async () => {
  const h = harness({ git: () => ({ status: 1, stdout: '', stderr: '' }) });
  await openWindow(h);
  h.clip.text = VALUE;
  const envLocal = join(h.root, '.env.local');
  const code = await run(h, ['set', 'SPK_TEST_KEY', '--to', envLocal]);
  assert.equal(code, 2);
  assert.match(h.output(), /not gitignored/);
  assert.equal(getMaster(h.userData, 'SPK_TEST_KEY'), undefined);
});

test('set: refuses ANTHROPIC_API_KEY', async () => {
  const h = harness();
  h.clip.text = VALUE;
  assert.equal(await run(h, ['set', 'ANTHROPIC_API_KEY', '--from-clipboard']), 2);
  assert.match(h.output(), /refused: ANTHROPIC_API_KEY/);
  assert.equal(await run(h, ['begin', 'acme', 'CLAUDE_CREDIT_KEY_ONE']), 2);
  assert.equal(existsSync(secretsPaths(h.userData).vault), false);
  assert.equal(readOp(h.userData), null);
});

test('set --wait timeout: exit 1 and the live-key warning', async () => {
  const h = harness();
  await openWindow(h);
  const later = new Date(NOW.getTime() + 30_000);
  h.deps.now = () => later;
  const code = await run(h, ['set', 'SPK_TEST_KEY', '--wait']);
  assert.equal(code, 1);
  assert.match(
    h.output(),
    /No copy seen in 2 min\. A acme key named robin-spk-test-key-20261113 may be live and unsaved — tell the operator\./,
  );
  assert.deepEqual(h.clip.notes, ['Click Copy on the acme tab']);
  assert.equal(readWindow(h.userData)?.expiresAt, new Date(NOW.getTime() + 150_000).toISOString());
  assert.equal(getMaster(h.userData, 'SPK_TEST_KEY'), undefined);
});

test('set --wait: extends the window and saves a fresh copy', async () => {
  let reads = 0;
  const h = harness();
  await openWindow(h);
  h.deps.clipboard = {
    read: () => (++reads > 2 ? VALUE : 'something the operator copied earlier'),
    clear: () => {},
    notify: () => {},
  };
  assert.equal(await run(h, ['set', 'SPK_TEST_KEY', '--wait']), 0);
  assert.equal(getMaster(h.userData, 'SPK_TEST_KEY'), VALUE);
});

test('set: window for another name exits 2', async () => {
  const h = harness();
  await openWindow(h);
  h.clip.text = VALUE;
  assert.equal(await run(h, ['set', 'OTHER_TEST_KEY']), 2);
  assert.match(h.output(), /window is for SPK_TEST_KEY/);
});

test('set with no source, no window: delivers the stored value to a new --to', async () => {
  const h = harness();
  setMaster(h.userData, 'SPK_TEST_KEY', VALUE);
  h.clip.text = OTHER; // must be ignored: no window, no --from-clipboard
  const envLocal = join(h.root, '.env.local');
  assert.equal(await run(h, ['set', 'SPK_TEST_KEY', '--to', envLocal]), 0);
  assert.equal(getMaster(h.userData, 'SPK_TEST_KEY'), VALUE);
  assert.match(readFileSync(envLocal, 'utf8'), new RegExp(`SPK_TEST_KEY=${VALUE}`));
  assert.match(h.output(), /already current/);
  assert.equal(h.clip.cleared, 0);
});

test('set: a failed clipboard clear still delivers and marks the window saved', async () => {
  const h = harness();
  await openWindow(h);
  h.deps.clipboard = {
    read: () => VALUE,
    clear: () => {
      throw new Error(`pbcopy failed near ${VALUE}`);
    },
    notify: () => {},
  };
  const envLocal = join(h.root, '.env.local');
  assert.equal(await run(h, ['set', 'SPK_TEST_KEY', '--to', envLocal]), 1);
  assert.equal(getMaster(h.userData, 'SPK_TEST_KEY'), VALUE);
  assert.ok(existsSync(envLocal));
  assert.equal(readWindow(h.userData)?.status, 'saved');
  assert.equal(readOp(h.userData), null);
  const out = h.output();
  assert.match(out, /failed: could not clear the clipboard — pbcopy failed near \[redacted\]/);
  assert.ok(!out.includes(VALUE));
});

test('set --stdin with no window: saves (human path)', async () => {
  const h = harness();
  assert.equal(await run(h, ['set', 'SPK_TEST_KEY', '--stdin']), 0);
  assert.equal(getMaster(h.userData, 'SPK_TEST_KEY'), VALUE);
});

test('set: rotation re-delivers recorded robin-env target and asks for restart', async () => {
  const h = harness();
  setMaster(h.userData, 'SPK_TEST_KEY', OTHER);
  await run(h, ['import']); // nothing in .env yet
  const robinEnv = secretsPaths(h.userData).robinEnv;
  mkdirSync(join(h.userData, 'config', 'secrets'), { recursive: true });
  writeFileSync(robinEnv, `SPK_TEST_KEY=${OTHER}\n`, { mode: 0o600 });
  const { addDelivery } = await import('../../lib/secrets/deliveries.ts');
  addDelivery(h.userData, 'SPK_TEST_KEY', { kind: 'robin-env', var: 'SPK_TEST_KEY' });
  addDelivery(h.userData, 'SPK_TEST_KEY', { kind: 'pipe', argv: ['vercel', 'env', 'add'] });
  await openWindow(h, 'SPK_TEST_KEY', ['--rotate']);
  h.clip.text = VALUE;
  assert.equal(await run(h, ['set', 'SPK_TEST_KEY']), 0);
  assert.match(readFileSync(robinEnv, 'utf8'), new RegExp(`SPK_TEST_KEY=${VALUE}`));
  const out = h.output();
  assert.match(
    out,
    /pipes to re-run: run `robin secret pipe SPK_TEST_KEY -- vercel env add` \(a dialog asks the operator\)/,
  );
  assert.match(out, /then: robin secret restart/);
});

test('pipe: operator Deny (or dialog give-up) exits 2 and never spawns', async () => {
  const h = harness();
  setMaster(h.userData, 'SPK_TEST_KEY', VALUE);
  h.approve = false;
  const code = await run(h, ['pipe', 'SPK_TEST_KEY', '--', 'vercel', 'env', 'add', 'X']);
  assert.equal(code, 2);
  assert.match(
    h.output(),
    /The operator did not approve sending SPK_TEST_KEY to vercel; nothing sent\./,
  );
  assert.deepEqual(h.spawned, []);
  assert.equal(h.confirms.length, 1);
  assert.match(h.confirms[0].body, /SPK_TEST_KEY/);
  assert.match(h.confirms[0].body, /vercel env add X/);
  assert.ok(!h.confirms[0].body.includes(VALUE));
  assert.equal(readDeliveries(h.userData).SPK_TEST_KEY, undefined);
});

test('pipe: the old --confirmed flag is not accepted and never spawns', async () => {
  const h = harness();
  setMaster(h.userData, 'SPK_TEST_KEY', VALUE);
  h.approve = true;
  assert.equal(await run(h, ['pipe', 'SPK_TEST_KEY', '--confirmed', '--', 'gh', 'secret']), 2);
  assert.deepEqual(h.spawned, []);
  assert.deepEqual(h.confirms, []);
});

test('pipe: operator Send spawns and records the target', async () => {
  const h = harness();
  setMaster(h.userData, 'SPK_TEST_KEY', VALUE);
  h.approve = true;
  assert.equal(await run(h, ['pipe', 'SPK_TEST_KEY', '--', 'gh', 'secret']), 0);
  assert.deepEqual(h.spawned, [['gh', 'secret']]);
  assert.deepEqual(readDeliveries(h.userData).SPK_TEST_KEY, [
    { kind: 'pipe', argv: ['gh', 'secret'] },
  ]);
});

test('arm without an arm-session record exits 2', async () => {
  const h = harness();
  await run(h, ['begin', 'acme', 'SPK_TEST_KEY']);
  const code = await run(h, ['arm', '--tab', '7']);
  assert.equal(code, 2);
  assert.match(h.output(), /arm must run from a Claude session with the secret hooks installed/);
  assert.equal(readWindow(h.userData), null);
});

test('arm: record for another tab exits 2 and writes nothing', async () => {
  const h = harness();
  await run(h, ['begin', 'acme', 'SPK_TEST_KEY']);
  writeArmSession(h.userData, { sessionId: 'sess-1', tabId: 8, at: NOW.toISOString() });
  assert.equal(await run(h, ['arm', '--tab', '7']), 2);
  assert.equal(readWindow(h.userData), null);
});

test('arm: refuses when a window file already exists', async () => {
  const h = harness();
  await openWindow(h);
  writeArmSession(h.userData, { sessionId: 'sess-1', tabId: 7, at: NOW.toISOString() });
  assert.equal(await run(h, ['arm', '--tab', '7']), 2);
  assert.match(h.output(), /A secret window is already open; run `robin secret abort` first\./);
});

test('arm: opens a 120 s window with the clipboard hash and prints the time', async () => {
  const h = harness();
  await openWindow(h);
  const w = readWindow(h.userData);
  assert.equal(w?.tabId, 7);
  assert.equal(w?.sessionId, 'sess-1');
  assert.equal(w?.name, 'SPK_TEST_KEY');
  assert.deepEqual(w?.scriptHashes, []);
  assert.equal(w?.expiresAt, new Date(NOW.getTime() + 120_000).toISOString());
  assert.match(h.output(), /window open for tab 7 until \d\d:\d\d:\d\d/);
});

test('abort: open window → aborted + live-key warning; again → closed', async () => {
  const h = harness();
  await openWindow(h);
  assert.equal(await run(h, ['abort']), 0);
  assert.equal(readWindow(h.userData)?.status, 'aborted');
  assert.equal(readOp(h.userData), null);
  assert.match(h.output(), /may be live and unsaved/);
  assert.equal(await run(h, ['abort']), 0);
  assert.equal(readWindow(h.userData), null);
});

function rawWindow(h: Harness): void {
  writeWindow(h.userData, {
    sessionId: 's',
    tabId: 1,
    provider: 'ebird',
    name: 'SPK_TEST_KEY',
    scriptHashes: [],
    clipboardHashAtArm: 'x',
    openedAt: NOW.toISOString(),
    expiresAt: NOW.toISOString(),
    status: 'open',
  });
}

test('abort: manual-mode window still warns (its flow clicks Create)', async () => {
  const h = harness();
  await run(h, ['begin', 'acme', 'SPK_TEST_KEY', '--get']);
  assert.equal(readOp(h.userData)?.mode, 'manual');
  rawWindow(h);
  assert.equal(await run(h, ['abort']), 0);
  assert.match(h.output(), /may be live and unsaved/);
});

test('abort: get-mode window has no live-key warning', async () => {
  const h = harness();
  writeOp(h.userData, {
    provider: 'ebird',
    name: 'SPK_TEST_KEY',
    mode: 'get',
    targets: [],
    startedAt: NOW.toISOString(),
  });
  rawWindow(h);
  assert.equal(await run(h, ['abort']), 0);
  assert.equal(readWindow(h.userData)?.status, 'aborted');
  assert.doesNotMatch(h.output(), /may be live/);
});

test('begin: manual mode prints the exact manual line and the dashboard name', async () => {
  const h = harness();
  assert.equal(await run(h, ['begin', 'acme', 'SPK_TEST_KEY']), 0);
  const out = h.output();
  assert.match(
    out,
    /No recipe for acme\. Drive the dashboard up to the reveal, ask for OK, then run: robin secret arm --tab <id>; click Create; robin secret set SPK_TEST_KEY --wait/,
  );
  assert.match(out, /robin-spk-test-key-20261113/);
  assert.equal(readOp(h.userData)?.mode, 'manual');
});

test('begin: refuses while a window exists', async () => {
  const h = harness();
  await openWindow(h);
  assert.equal(await run(h, ['begin', 'acme', 'OTHER_TEST_KEY']), 2);
  assert.equal(readOp(h.userData)?.name, 'SPK_TEST_KEY');
});

test('begin google: prints reauth and arms nothing', async () => {
  const h = harness();
  assert.equal(await run(h, ['begin', 'google', 'GOOGLE_CALENDAR_REFRESH_TOKEN', '--rotate']), 0);
  assert.match(h.output(), /run: robin reauth google_calendar/);
  assert.equal(readOp(h.userData), null);
});

test('beginLines: recipe scripts with sha256, create-revoke rotate line', () => {
  const lines = beginLines({
    recipe: linear,
    provider: 'linear',
    name: 'LINEAR_API_KEY',
    mode: 'rotate',
    targets: [linear.target],
    now: NOW,
  }).join('\n');
  assert.match(lines, /https:\/\/linear\.app/);
  assert.match(lines, /sha256 [0-9a-f]{64}/);
  assert.ok(lines.includes(linear.locateCopy as string));
  assert.match(
    lines,
    /At the revoke step, list the dashboard's key NAMES \(never values\) and ask the operator which to revoke, or "keep"\./,
  );
  assert.match(lines, /robin-linear-api-key-20261113/);
  const roll = beginLines({
    recipe: cloudflare,
    provider: 'cloudflare',
    name: 'CLOUDFLARE_API_TOKEN',
    mode: 'rotate',
    targets: [],
    now: NOW,
  }).join('\n');
  assert.doesNotMatch(roll, /revoke step, list/);
});

test('exec: runs with the names and never prints the value', async () => {
  const h = harness();
  setMaster(h.userData, 'SPK_TEST_KEY', VALUE);
  assert.equal(await run(h, ['exec', 'SPK_TEST_KEY', '--', 'node', '-v']), 0);
  assert.deepEqual(h.spawned, [['node', '-v']]);
  assert.equal(await run(h, ['exec', 'ANTHROPIC_API_KEY', '--', 'node']), 2);
});

test('restart: bounces the daemon and prints the /mcp line', async () => {
  const h = harness();
  assert.equal(await run(h, ['restart']), 0);
  assert.equal(h.restarts, 1);
  assert.match(h.output(), /run \/mcp in open Claude sessions that use Robin tools/);
});

test('deliveries: corrupt registry is reported, exit 1', async () => {
  const h = harness();
  const f = secretsPaths(h.userData).deliveries;
  mkdirSync(join(h.userData, 'state', 'runtime'), { recursive: true });
  writeFileSync(f, '{not json');
  assert.equal(await run(h, ['deliveries']), 1);
  assert.match(h.output(), /corrupt delivery registry/);
});

test('no subcommand output ever contains the fixture value', async () => {
  const h = harness();
  const robinEnv = secretsPaths(h.userData).robinEnv;
  mkdirSync(join(h.userData, 'config', 'secrets'), { recursive: true });
  writeFileSync(robinEnv, `IMPORTED_TEST_TOKEN=${OTHER}\n`, { mode: 0o600 });
  await run(h, ['import']);
  await openWindow(h);
  await run(h, ['set', 'SPK_TEST_KEY']); // unchanged clipboard
  await run(h, ['set', 'SPK_TEST_KEY', '--wait']); // timeout
  h.clip.text = VALUE;
  const envLocal = join(h.root, '.env.local');
  await run(h, ['set', 'SPK_TEST_KEY', '--to', envLocal]);
  await run(h, ['set', 'SPK_TEST_KEY', '--to', envLocal]);
  await run(h, ['abort']);
  await run(h, ['abort']);
  await run(h, ['set', 'SPK_TEST_KEY', '--stdin']);
  await run(h, ['set', 'ANTHROPIC_API_KEY', '--stdin']);
  await run(h, ['list']);
  await run(h, ['deliver', 'SPK_TEST_KEY']);
  await run(h, ['deliver', 'IMPORTED_TEST_TOKEN']);
  await run(h, ['deliveries']);
  await run(h, ['deliveries', '--prune']);
  await run(h, ['exec', 'SPK_TEST_KEY', '--', 'env']);
  // exec/pipe use a fake spawn, so this proves only that the CLI's own lines
  // carry no value; a real child that prints its input is caught by the
  // PostToolUse redaction hook, the actual backstop.
  h.approve = false;
  await run(h, ['pipe', 'SPK_TEST_KEY', '--', 'cat']);
  h.approve = true;
  await run(h, ['pipe', 'SPK_TEST_KEY', '--', 'cat']);
  await run(h, ['log', '--limit', '50']);
  await run(h, ['restart']);
  await run(h, ['nonsense']);
  await run(h, []);
  const out = h.output();
  assert.ok(out.length > 0);
  for (const v of [VALUE, OTHER]) {
    assert.ok(!out.includes(v), 'a key value reached the output');
    assert.ok(!out.includes(v.slice(0, 12)), 'a key prefix reached the output');
  }
  // Each value-holding path actually ran.
  for (const re of [
    /hasn't changed since arm/,
    /No copy seen in 2 min/,
    /SPK_TEST_KEY …5678 \(33\) · saved/,
    /already current/,
    /window closed/,
    /refused: ANTHROPIC_API_KEY/,
    /IMPORTED_TEST_TOKEN …9999 \(33\)/,
    /did not approve sending SPK_TEST_KEY/,
    /piped SPK_TEST_KEY …5678 \(33\) to cat · exit 0/,
    /\d{4}-\d\d-\d\dT\S+ set - SPK_TEST_KEY …5678 \(33\)/,
  ]) {
    assert.match(out, re);
  }
});

test('set --wait with no window: only a copy made during the wait counts', async () => {
  const h = harness();
  setMaster(h.userData, 'SPK_TEST_KEY', OTHER);
  h.clip.text = 'https://example.com/a-long-url-that-matches-the-default-shape';
  assert.equal(await run(h, ['set', 'SPK_TEST_KEY', '--wait']), 1);
  assert.equal(getMaster(h.userData, 'SPK_TEST_KEY'), OTHER);
  let reads = 0;
  h.deps.clipboard = {
    read: () =>
      ++reads > 3 ? VALUE : 'https://example.com/a-long-url-that-matches-the-default-shape',
    clear: () => {},
    notify: () => {},
  };
  assert.equal(await run(h, ['set', 'SPK_TEST_KEY', '--wait']), 0);
  assert.equal(getMaster(h.userData, 'SPK_TEST_KEY'), VALUE);
});

test('set --from-clipboard with no window: refused, nothing read', async () => {
  const h = harness();
  h.clip.text = VALUE;
  let reads = 0;
  h.deps.clipboard = {
    read: () => {
      reads++;
      return VALUE;
    },
    clear: () => {},
    notify: () => {},
  };
  assert.equal(await run(h, ['set', 'SPK_TEST_KEY', '--from-clipboard']), 2);
  assert.match(h.output(), /no armed window — use --wait so the copy is fresh/);
  assert.equal(reads, 0);
  assert.equal(getMaster(h.userData, 'SPK_TEST_KEY'), undefined);
});

test('set: pending create op without a window is refused for --wait and --from-clipboard', async () => {
  const h = harness();
  await run(h, ['begin', 'acme', 'SPK_TEST_KEY']);
  for (const src of ['--wait', '--from-clipboard']) {
    assert.equal(await run(h, ['set', 'SPK_TEST_KEY', src]), 2);
  }
  assert.match(
    h.output(),
    /pending manual for SPK_TEST_KEY has no armed window; run `robin secret arm --tab <id>` first/,
  );
});

test('every --wait suggestion carries the Bash timeout hint', async () => {
  const h = harness();
  await openWindow(h);
  await run(h, ['set', 'SPK_TEST_KEY']); // unchanged → retry line
  const lines = h
    .output()
    .split('\n')
    .filter((l) => l.includes('--wait'));
  assert.ok(lines.length >= 2);
  for (const l of lines) assert.match(l, /timeout of at least 150000 ms/);
});

test('set --wait timeout in get mode: no live-key warning', async () => {
  const h = harness();
  writeOp(h.userData, {
    provider: 'ebird',
    name: 'SPK_TEST_KEY',
    mode: 'get',
    targets: [],
    startedAt: NOW.toISOString(),
  });
  rawWindow(h);
  h.deps.now = () => new Date(NOW.getTime() - 1000); // window not yet expired
  assert.equal(await run(h, ['set', 'SPK_TEST_KEY', '--wait']), 1);
  assert.match(h.output(), /No copy seen in 2 min; nothing saved\./);
  assert.doesNotMatch(h.output(), /may be live/);
});

test('log --limit 0 prints nothing', async () => {
  const h = harness();
  await run(h, ['begin', 'acme', 'SPK_TEST_KEY']);
  writeArmSession(h.userData, { sessionId: 's', tabId: 7, at: NOW.toISOString() });
  await run(h, ['arm', '--tab', '7']);
  const before = h.lines.length;
  assert.equal(await run(h, ['log', '--limit', '0']), 0);
  assert.equal(h.lines.length, before);
});

test('abort: unreadable window → one message plus the live-key warning', async () => {
  const h = harness();
  await run(h, ['begin', 'acme', 'SPK_TEST_KEY', '--rotate']);
  writeFileSync(secretsPaths(h.userData).window, '{}');
  assert.equal(await run(h, ['abort']), 0);
  const out = h.output();
  assert.match(out, /window closed \(its file was unreadable\)/);
  assert.match(out, /robin-spk-test-key-20261113 may be live and unsaved/);
  assert.equal(existsSync(secretsPaths(h.userData).window), false);
});

test('arm: op with an unparseable startedAt counts as stale', async () => {
  const h = harness();
  writeOp(h.userData, {
    provider: 'acme',
    name: 'SPK_TEST_KEY',
    mode: 'manual',
    targets: [],
    startedAt: 'not a date',
  });
  writeArmSession(h.userData, { sessionId: 's', tabId: 7, at: NOW.toISOString() });
  assert.equal(await run(h, ['arm', '--tab', '7']), 2);
  assert.match(h.output(), /over 1 h old/);
  assert.equal(readWindow(h.userData), null);
});

test('set: target written but registry write fails → delivered but not recorded', async () => {
  const h = harness();
  await openWindow(h);
  h.clip.text = VALUE;
  const envLocal = join(h.root, '.env.local');
  // Only the registry write fails: its tmp path is taken by a directory.
  mkdirSync(`${secretsPaths(h.userData).deliveries}.tmp-${process.pid}`);
  assert.equal(await run(h, ['set', 'SPK_TEST_KEY', '--to', envLocal]), 1);
  assert.equal(readWindow(h.userData)?.status, 'saved');
  const out = h.output();
  assert.doesNotMatch(out, /^failed:/m);
  assert.match(readFileSync(envLocal, 'utf8'), new RegExp(`SPK_TEST_KEY=${VALUE}`));
  assert.match(out, /delivered: 1 files/);
  assert.match(out, /delivered but not recorded \(a rotation won't update it\): \S+\.env\.local/);
  assert.doesNotMatch(out, /failed: \S+\.env\.local/);
  assert.ok(!out.includes(VALUE));
});

test('confirm dialog script: escapes \\ and ", Deny is default and cancel, gives up at 120 s', () => {
  assert.equal(appleScriptString('a"b\\c\nd'), '"a\\"b\\\\c\\nd"');
  const script = confirmScript('T', 'say "hi"');
  assert.match(
    script,
    /buttons \{"Deny", "Send"\} default button "Deny" cancel button "Deny" giving up after 120$/,
  );
  assert.ok(script.includes('"say \\"hi\\""'));
});

test('set --wait timeout with no op at all: only "No copy seen in 2 min."', async () => {
  const h = harness();
  h.clip.text = 'already there before the wait started';
  assert.equal(await run(h, ['set', 'SPK_TEST_KEY', '--wait']), 1);
  assert.equal(h.output(), 'No copy seen in 2 min.');
});

test('pipe dialog: bidi and zero-width chars in argv are shown escaped', async () => {
  const h = harness();
  setMaster(h.userData, 'SPK_TEST_KEY', VALUE);
  h.approve = false;
  await run(h, ['pipe', 'SPK_TEST_KEY', '--', 'gh', 'secret', 'set', 'safe\u202Ehs.lit\u200Bcat']);
  const body = h.confirms[0].body;
  assert.ok(!/[^\x20-\x7e\n]/.test(body), 'only printable ASCII (and newlines) in the dialog');
  assert.ok(body.includes('"safe\\u202ehs.lit\\u200bcat"'));
  assert.equal(dialogWord('a\u2066b'), '"a\\u2066b"');
  assert.equal(dialogWord('plain-word'), 'plain-word');
});

test('default confirm runs /usr/bin/osascript with a fixed env, Send only', () => {
  const calls: { file: string; env: unknown }[] = [];
  const confirm = (out: string | Error) =>
    macConfirmWith((file, _args, opts) => {
      calls.push({ file, env: opts.env });
      if (out instanceof Error) throw out;
      return out;
    });
  assert.equal(confirm('button returned:Send, gave up:false')('t', 'b'), true);
  assert.equal(confirm('button returned:, gave up:true')('t', 'b'), false);
  assert.equal(confirm(new Error('User canceled. (-128)'))('t', 'b'), false);
  for (const c of calls) {
    assert.equal(c.file, '/usr/bin/osascript');
    assert.deepEqual(c.env, { PATH: '/usr/bin:/bin' });
  }
});

test('install / uninstall: hooks pinned to this userData + rule file, under a temp HOME', async () => {
  const h = harness();
  const home = join(h.root, 'home');
  h.deps.home = home;
  assert.equal(await run(h, ['install']), 0);
  const settingsPath = join(home, '.claude', 'settings.json');
  const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
  const pre = settings.hooks.PreToolUse[0].hooks[0].command as string;
  const post = settings.hooks.PostToolUse[0].hooks[0].command as string;
  assert.ok(pre.includes(`ROBIN_USER_DATA_DIR='${h.userData}'`));
  assert.ok(post.includes(`ROBIN_USER_DATA_DIR='${h.userData}'`));
  const rule = join(home, '.claude', 'rules', 'secrets.md');
  assert.ok(existsSync(rule));
  const out = h.output();
  assert.match(out, /hooks: installed PreToolUse \+ PostToolUse in .*settings\.json/);
  assert.match(out, /rule file: .*secrets\.md/);

  assert.equal(await run(h, ['uninstall']), 0);
  const after = JSON.parse(readFileSync(settingsPath, 'utf8'));
  assert.equal(after.hooks.PreToolUse, undefined);
  assert.equal(after.hooks.PostToolUse, undefined);
  assert.equal(existsSync(rule), false);
  assert.match(h.output(), /hooks: removed/);
});
