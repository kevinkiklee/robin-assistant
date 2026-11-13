import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
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
  type DeliveryTarget,
  deliverToEnvLocal,
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
