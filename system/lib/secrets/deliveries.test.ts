import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  addDelivery,
  checkIgnored,
  type DeliveryTarget,
  deliverToEnvLocal,
  pruneMissing,
  readDeliveries,
  redeliverFileTargets,
  runExec,
  runPipe,
} from './deliveries.ts';
import { setMaster } from './store.ts';

const tmp = () => mkdtempSync(join(tmpdir(), 'robin-deliv-'));
const VAL = 'spk_test_0123456789abcdef';

function gitInit(dir: string): void {
  const r = spawnSync('git', ['init', '-q'], { cwd: dir });
  assert.equal(r.status, 0);
}

test('deliverToEnvLocal: refuses an un-ignored file in a repo', () => {
  const dir = tmp();
  gitInit(dir);
  const p = join(dir, '.env.local');
  assert.throws(() => deliverToEnvLocal(p, 'X', 'v'), /not gitignored/);
  assert.equal(existsSync(p), false);
});

test('deliverToEnvLocal: writes when ignored', () => {
  const dir = tmp();
  gitInit(dir);
  writeFileSync(join(dir, '.gitignore'), '.env.local\n');
  const p = join(dir, '.env.local');
  deliverToEnvLocal(p, 'X', 'v');
  assert.match(readFileSync(p, 'utf8'), /^X=v$/m);
  assert.equal(statSync(p).mode & 0o777, 0o600);
});

test('deliverToEnvLocal: never leaves a .bak-* beside the target (a .env.local pattern would not ignore it)', () => {
  const dir = tmp();
  gitInit(dir);
  writeFileSync(join(dir, '.gitignore'), '.env.local\n');
  const p = join(dir, '.env.local');
  deliverToEnvLocal(p, 'X', VAL);
  deliverToEnvLocal(p, 'X', `${VAL}2`);
  assert.deepEqual(
    readdirSync(dir).filter((f) => f.includes('.bak-')),
    [],
  );
  assert.match(readFileSync(p, 'utf8'), new RegExp(`^X=${VAL}2$`, 'm'));
});

test('redeliverFileTargets: env-local re-delivery leaves no .bak-*', () => {
  const ud = tmp();
  const dir = tmp();
  gitInit(dir);
  writeFileSync(join(dir, '.gitignore'), '.env*.local\n');
  const t: DeliveryTarget = { kind: 'env-local', path: join(dir, '.env.local'), var: 'K' };
  addDelivery(ud, 'K', t);
  redeliverFileTargets(ud, 'K', VAL);
  redeliverFileTargets(ud, 'K', `${VAL}2`);
  assert.deepEqual(
    readdirSync(dir).filter((f) => f.includes('.bak-')),
    [],
  );
});

test('deliverToEnvLocal: writes outside any repo', () => {
  const dir = tmp();
  const p = join(dir, '.env.local');
  deliverToEnvLocal(p, 'X', 'v');
  assert.match(readFileSync(p, 'utf8'), /^X=v$/m);
});

test('redeliverFileTargets: missing target reported, others written', () => {
  const ud = tmp();
  const a = tmp();
  const b = tmp();
  const ta: DeliveryTarget = { kind: 'env-local', path: join(a, '.env.local'), var: 'K' };
  const tb: DeliveryTarget = { kind: 'env-local', path: join(b, '.env.local'), var: 'K' };
  addDelivery(ud, 'K', ta);
  addDelivery(ud, 'K', tb);
  rmSync(b, { recursive: true });
  const r = redeliverFileTargets(ud, 'K', VAL);
  assert.equal(r.written.length, 1);
  assert.equal(r.missing.length, 1);
  assert.deepEqual(r.missing[0], tb);
  assert.match(readFileSync(ta.path, 'utf8'), new RegExp(VAL));
});

test('redeliverFileTargets: pipes are listed, never run', () => {
  const ud = tmp();
  const pipe: DeliveryTarget = { kind: 'pipe', argv: ['somecli', 'login'] };
  addDelivery(ud, 'K', pipe);
  const r = redeliverFileTargets(ud, 'K', VAL);
  assert.deepEqual(r.pipes, [pipe]);
  assert.equal(r.written.length, 0);
});

test('runPipe: value goes to stdin, not argv or env', () => {
  let seen: { cmd: string; args: string[]; opts: Record<string, unknown> } | undefined;
  const spawn = ((cmd: string, args: string[], opts: Record<string, unknown>) => {
    seen = { cmd, args, opts };
    return { status: 0 };
  }) as unknown as typeof spawnSync;
  const code = runPipe(['somecli', 'login', '--stdin'], VAL, spawn);
  assert.equal(code, 0);
  assert.ok(seen);
  assert.equal(seen.cmd, 'somecli');
  assert.equal(seen.opts.input, VAL);
  assert.ok(!seen.args.join(' ').includes(VAL));
  assert.ok(!JSON.stringify(seen.opts.env ?? {}).includes(VAL));
  assert.deepEqual(seen.opts.stdio, ['pipe', 'inherit', 'inherit']);
});

test('runExec: injects master values into env only', () => {
  const ud = tmp();
  setMaster(ud, 'SPK_TEST_KEY', VAL);
  let seen: { args: string[]; opts: { env: Record<string, string>; stdio: string } } | undefined;
  const spawn = ((_c: string, args: string[], opts: never) => {
    seen = { args, opts };
    return { status: 3 };
  }) as unknown as typeof spawnSync;
  assert.equal(runExec(['SPK_TEST_KEY'], ['tool', '--x'], ud, spawn), 3);
  assert.ok(seen);
  assert.equal(seen.opts.env.SPK_TEST_KEY, VAL);
  assert.equal(seen.opts.stdio, 'inherit');
  assert.ok(!seen.args.join(' ').includes(VAL));
});

test('addDelivery: no duplicates, file 0600 and value-free', () => {
  const ud = tmp();
  mkdirSync(join(ud, 'state', 'runtime'), { recursive: true });
  const t: DeliveryTarget = { kind: 'robin-env', var: 'K' };
  addDelivery(ud, 'K', t);
  addDelivery(ud, 'K', { kind: 'robin-env', var: 'K' });
  assert.equal(readDeliveries(ud).K.length, 1);
  const f = join(ud, 'state', 'runtime', 'secret-deliveries.json');
  assert.equal(statSync(f).mode & 0o777, 0o600);
});

test('checkIgnored: relative ignored path resolves', () => {
  const dir = tmp();
  gitInit(dir);
  writeFileSync(join(dir, '.gitignore'), '.env.local\n');
  mkdirSync(join(dir, 'proj'));
  writeFileSync(join(dir, 'proj', '.gitignore'), '');
  const prev = process.cwd();
  process.chdir(dir);
  try {
    assert.equal(checkIgnored('proj/.env.local'), 'ignored');
  } finally {
    process.chdir(prev);
  }
});

test('checkIgnored: git spawn failure fails closed', () => {
  const dir = tmp();
  const git = () => ({ status: null, stdout: '', stderr: '' });
  assert.equal(checkIgnored(join(dir, '.env.local'), git), 'not-ignored');
  assert.throws(
    () => deliverToEnvLocal(join(dir, '.env.local'), 'X', 'v', { git }),
    /not gitignored/,
  );
  assert.equal(existsSync(join(dir, '.env.local')), false);
});

test('checkIgnored: other git error (no "not a git repository") fails closed', () => {
  const git = () => ({ status: 128, stdout: '', stderr: 'fatal: detected dubious ownership' });
  assert.equal(checkIgnored(join(tmp(), '.env.local'), git), 'not-ignored');
});

test('checkIgnored: not-a-repo message but ancestor has .git fails closed', () => {
  const dir = tmp();
  mkdirSync(join(dir, '.git'));
  const git = () => ({ status: 128, stdout: '', stderr: 'fatal: not a git repository' });
  assert.equal(checkIgnored(join(dir, '.env.local'), git), 'not-ignored');
});

test('checkIgnored: path in a non-existing subdir of a repo is not outside-repo', () => {
  const dir = tmp();
  gitInit(dir);
  assert.notEqual(checkIgnored(join(dir, 'nope', 'deep', '.env.local')), 'outside-repo');
});

test('redeliverFileTargets: un-ignored target 2 of 3 goes to failed, others written', () => {
  const ud = tmp();
  const dirs = [tmp(), tmp(), tmp()];
  gitInit(dirs[1]);
  const targets = dirs.map(
    (d): DeliveryTarget => ({ kind: 'env-local', path: join(d, '.env.local'), var: 'K' }),
  );
  for (const t of targets) addDelivery(ud, 'K', t);
  const r = redeliverFileTargets(ud, 'K', VAL);
  assert.equal(r.written.length, 2);
  assert.equal(r.failed.length, 1);
  assert.deepEqual(r.failed[0].target, targets[1]);
  assert.ok(!r.failed[0].error.includes(VAL));
  assert.ok(existsSync(targets[0].kind === 'env-local' ? targets[0].path : ''));
  assert.ok(existsSync(targets[2].kind === 'env-local' ? targets[2].path : ''));
  assert.equal(
    readFileSync(join(ud, 'state', 'runtime', 'secret-deliveries.json'), 'utf8').includes(VAL),
    false,
  );
});

test('readDeliveries: corrupt JSON throws', () => {
  const ud = tmp();
  mkdirSync(join(ud, 'state', 'runtime'), { recursive: true });
  writeFileSync(join(ud, 'state', 'runtime', 'secret-deliveries.json'), '{not json');
  assert.throws(() => readDeliveries(ud), /corrupt/);
  assert.throws(() => addDelivery(ud, 'K', { kind: 'robin-env', var: 'K' }), /corrupt/);
});

test('addDelivery: stores absolute paths', () => {
  const ud = tmp();
  addDelivery(ud, 'K', { kind: 'secret-file', path: 'rel/key.txt' });
  const t = readDeliveries(ud).K[0];
  assert.equal(t.kind === 'secret-file' && t.path.startsWith('/'), true);
});

test('runPipe: real process receives value on stdin', () => {
  const out = join(tmp(), 'got.txt');
  assert.equal(runPipe(['sh', '-c', `cat > '${out}'`], VAL), 0);
  assert.equal(readFileSync(out, 'utf8'), VAL);
});

test('pruneMissing: removes targets whose dir is gone', () => {
  const ud = tmp();
  const gone = tmp();
  const keep = tmp();
  addDelivery(ud, 'K', { kind: 'secret-file', path: join(gone, 'k') });
  addDelivery(ud, 'K', { kind: 'secret-file', path: join(keep, 'k') });
  addDelivery(ud, 'K', { kind: 'pipe', argv: ['x'] });
  rmSync(gone, { recursive: true });
  const removed = pruneMissing(ud);
  assert.equal(removed.length, 1);
  assert.equal(readDeliveries(ud).K.length, 2);
});
