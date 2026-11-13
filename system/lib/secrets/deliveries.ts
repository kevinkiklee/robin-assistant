import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { writeEnvKey, writeSecretFile } from './env-file.ts';
import { getMaster, secretsPaths } from './store.ts';

export type DeliveryTarget =
  | { kind: 'robin-env'; var: string }
  | { kind: 'env-local'; path: string; var: string }
  | { kind: 'secret-file'; path: string }
  | { kind: 'pipe'; argv: string[] };

type GitFn = (
  args: string[],
  cwd: string,
) => { status: number | null; stdout: string; stderr?: string };

const defaultGit: GitFn = (args, cwd) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } });
  return { status: r.error ? null : r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
};

function expandHome(p: string): string {
  return p === '~' || p.startsWith('~/') ? join(homedir(), p.slice(1)) : p;
}

/** `~` expanded, then absolute. */
function absPath(p: string): string {
  return resolve(expandHome(p));
}

function normalizeTarget(t: DeliveryTarget): DeliveryTarget {
  return t.kind === 'env-local' || t.kind === 'secret-file' ? { ...t, path: absPath(t.path) } : t;
}

export function readDeliveries(userData: string): Record<string, DeliveryTarget[]> {
  const f = secretsPaths(userData).deliveries;
  if (!existsSync(f)) return {};
  try {
    return JSON.parse(readFileSync(f, 'utf8')) as Record<string, DeliveryTarget[]>;
  } catch (err) {
    throw new Error(`corrupt delivery registry ${f}: ${(err as Error).message}`);
  }
}

function writeDeliveries(userData: string, data: Record<string, DeliveryTarget[]>): void {
  const f = secretsPaths(userData).deliveries;
  mkdirSync(dirname(f), { recursive: true });
  const tmp = `${f}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, f);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

export function addDelivery(userData: string, name: string, target: DeliveryTarget): void {
  const t = normalizeTarget(target);
  const all = readDeliveries(userData);
  const list = all[name] ?? [];
  const key = JSON.stringify(t);
  if (list.some((x) => JSON.stringify(x) === key)) return;
  all[name] = [...list, t];
  writeDeliveries(userData, all);
}

function nearestExistingDir(p: string): string {
  let d = dirname(p);
  while (!existsSync(d) && dirname(d) !== d) d = dirname(d);
  return d;
}

function ancestorHasGit(p: string): boolean {
  let d = dirname(p);
  for (;;) {
    if (existsSync(join(d, '.git'))) return true;
    if (dirname(d) === d) return false;
    d = dirname(d);
  }
}

/**
 * Fails closed: 'outside-repo' only when git ran, said "not a git repository",
 * and no ancestor holds a `.git`. Any other failure counts as 'not-ignored'.
 */
export function checkIgnored(
  path: string,
  git: GitFn = defaultGit,
): 'ignored' | 'outside-repo' | 'not-ignored' {
  const abs = absPath(path);
  const cwd = nearestExistingDir(abs);
  const top = git(['rev-parse', '--show-toplevel'], cwd);
  if (top.status !== 0) {
    const notRepo = top.status !== null && /not a git repository/i.test(top.stderr ?? '');
    return notRepo && !ancestorHasGit(abs) ? 'outside-repo' : 'not-ignored';
  }
  return git(['check-ignore', '-q', abs], cwd).status === 0 ? 'ignored' : 'not-ignored';
}

export function deliverToEnvLocal(
  path: string,
  varName: string,
  value: string,
  deps: { git?: GitFn } = {},
): void {
  const p = absPath(path);
  if (checkIgnored(p, deps.git) === 'not-ignored') {
    throw new Error(`refused: ${p} is not gitignored`);
  }
  // No backups: `.env.local.bak-<ts>` is not matched by a `.env.local` or
  // `.env*.local` gitignore pattern, so a backup would put the key in git.
  // The vault keeps the history.
  writeEnvKey(p, varName, value, { backups: false });
}

export function deliverFileTarget(userData: string, t: DeliveryTarget, value: string): void {
  switch (t.kind) {
    case 'robin-env': {
      const p = secretsPaths(userData).robinEnv;
      mkdirSync(dirname(p), { recursive: true });
      writeEnvKey(p, t.var, value);
      return;
    }
    case 'env-local':
      deliverToEnvLocal(t.path, t.var, value);
      return;
    case 'secret-file':
      writeSecretFile(absPath(t.path), value);
      return;
    case 'pipe':
      throw new Error('pipe targets never run implicitly');
  }
}

function targetDirGone(t: DeliveryTarget): boolean {
  return (
    (t.kind === 'env-local' || t.kind === 'secret-file') && !existsSync(dirname(absPath(t.path)))
  );
}

export function redeliverFileTargets(
  userData: string,
  name: string,
  value: string,
): {
  written: DeliveryTarget[];
  missing: DeliveryTarget[];
  failed: { target: DeliveryTarget; error: string }[];
  pipes: DeliveryTarget[];
} {
  const out = {
    written: [] as DeliveryTarget[],
    missing: [] as DeliveryTarget[],
    failed: [] as { target: DeliveryTarget; error: string }[],
    pipes: [] as DeliveryTarget[],
  };
  for (const t of readDeliveries(userData)[name] ?? []) {
    if (t.kind === 'pipe') out.pipes.push(t);
    else if (targetDirGone(t)) out.missing.push(t);
    else {
      try {
        deliverFileTarget(userData, t, value);
        out.written.push(t);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        out.failed.push({ target: t, error: msg.split(value).join('[redacted]') });
      }
    }
  }
  return out;
}

export function pruneMissing(userData: string): DeliveryTarget[] {
  const all = readDeliveries(userData);
  const removed: DeliveryTarget[] = [];
  for (const name of Object.keys(all)) {
    const keep: DeliveryTarget[] = [];
    for (const t of all[name]) (targetDirGone(t) ? removed : keep).push(t);
    if (keep.length) all[name] = keep;
    else delete all[name];
  }
  if (removed.length) writeDeliveries(userData, all);
  return removed;
}

export function runPipe(
  argv: string[],
  value: string,
  spawn: typeof spawnSync = spawnSync,
): number {
  const [cmd, ...args] = argv;
  const r = spawn(cmd, args, { input: value, stdio: ['pipe', 'inherit', 'inherit'] });
  return r.status ?? 1;
}

export function runExec(
  names: string[],
  argv: string[],
  userData: string,
  spawn: typeof spawnSync = spawnSync,
): number {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const n of names) {
    const v = getMaster(userData, n);
    if (v === undefined) throw new Error(`${n} is not in the vault`);
    env[n] = v;
  }
  const [cmd, ...args] = argv;
  const r = spawn(cmd, args, { env, stdio: 'inherit' });
  return r.status ?? 1;
}
