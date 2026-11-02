// lab/sandbox/guards.ts
//
// Known gaps (tripwires, not a jail): the egress guard wraps global `fetch` and
// `http(s).request/get` only. It does NOT cover `net`, `tls`, `http2`, direct
// `undici`, `WebSocket`, `dns`, or child processes. The `claude-agent` provider
// spawns the claude CLI, which makes its own network calls; it is blocked ONLY by
// `assertLabModels`. The path guard covers `openDb`, not arbitrary `fs` writes.
import { existsSync, realpathSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import { dirname, resolve, sep } from 'node:path';
import { registerDbGuard } from '../../system/brain/memory/db.ts';
import type { ModelsConfig } from '../../system/kernel/config/schema.ts';
import { registerUserDataDirGuard } from '../../system/lib/paths.ts';
import { LabIsolationError } from './errors.ts';

export const LAB_ALLOWED_HOSTS: readonly string[] = [
  'api.anthropic.com',
  'generativelanguage.googleapis.com',
  '127.0.0.1:11434',
  'localhost:11434',
];

export const LAB_ALLOWED_PROVIDERS: readonly string[] = ['anthropic', 'google', 'ollama'];

/**
 * Canonical form of a path for comparison: made absolute (so `..` segments are
 * collapsed BEFORE walking), then the deepest existing ancestor is resolved with
 * `realpathSync.native` (symlinks and the on-disk case of case-insensitive
 * filesystems) and the missing tail is re-joined. Works for paths that do not
 * exist yet.
 */
export function resolveForCheck(p: string): string {
  let head = resolve(p);
  const tail: string[] = [];
  while (!existsSync(head)) {
    const up = dirname(head);
    if (up === head) break;
    tail.unshift(head.slice(up.length + (up.endsWith(sep) ? 0 : 1)));
    head = up;
  }
  return [realpathSync.native(head), ...tail].join(sep);
}

// APFS / NTFS are case-insensitive by default; a missing tail keeps the caller's
// spelling, so compare case-folded as a backstop (a false positive only refuses).
const FOLD = process.platform === 'darwin' || process.platform === 'win32';
const fold = (s: string) => (FOLD ? s.toLowerCase() : s);

export function isUnder(p: string, root: string): boolean {
  const a = fold(p);
  const r = fold(root);
  return a === r || a.startsWith(r.endsWith(sep) ? r : r + sep);
}

/**
 * Throw LabIsolationError when `path` (canonicalized with resolveForCheck) is at or under
 * any of `forbidden`. For lab code that writes with plain fs/SQLite outside the db guard.
 */
export function assertOutsideLive(path: string, forbidden: string[], what: string): void {
  const real = resolveForCheck(path);
  for (const f of forbidden) {
    const root = resolveForCheck(f);
    if (isUnder(real, root))
      throw new LabIsolationError(`lab: refused ${what} ${path} (under live root ${root})`);
  }
}

export function installPathGuard(forbidden: string[]): () => void {
  const roots = forbidden.map((f) => resolveForCheck(f));
  const check = (path: string, verb: string) => {
    const real = resolveForCheck(path);
    for (const root of roots) {
      if (isUnder(real, root))
        throw new LabIsolationError(`lab: refused to ${verb} ${path} (under live root ${root})`);
    }
  };
  const offDb = registerDbGuard((path) => check(path, 'open'));
  const offDir = registerUserDataDirGuard((dir) => check(dir, 'resolve'));
  return () => {
    offDir();
    offDb();
  };
}

const DEFAULT_PORTS = new Set(['80', '443']);
const FORBIDDEN_NET_OPTIONS = ['lookup', 'socketPath', 'createConnection', 'agent'] as const;

function refuseOverrides(opts: Record<string, unknown>, keys: readonly string[]): void {
  for (const k of keys) {
    if (opts[k] !== undefined) throw new LabIsolationError(`lab: egress option "${k}" refused`);
  }
}

/** Host spellings for the target as `fetch` sees it: always the stringified URL. */
function fetchTarget(input: unknown): { url: string; hosts: string[] } {
  const url = input instanceof Request ? input.url : String(input);
  return { url, hosts: [new URL(url).host] };
}

/**
 * Host spellings for an `http(s).request/get` call, merged the way Node merges
 * `(url, options)`: options.hostname / host / port override the URL's.
 */
function requestHosts(args: unknown[]): string[] {
  const [first, second] = args;
  let url: URL | undefined;
  let opts: Record<string, unknown> = {};
  if (typeof first === 'string' || first instanceof URL) {
    url = new URL(String(first));
    if (second && typeof second === 'object') opts = second as Record<string, unknown>;
  } else if (first && typeof first === 'object') {
    opts = first as Record<string, unknown>;
  }
  refuseOverrides(opts, FORBIDDEN_NET_OPTIONS);
  // Node: hostname wins over host; both override the URL.
  const name = String(opts.hostname ?? url?.hostname ?? opts.host ?? 'localhost');
  const port = String(opts.port ?? url?.port ?? '');
  const hosts = port ? [`${name}:${port}`] : [];
  if (!port || DEFAULT_PORTS.has(port)) hosts.push(name);
  return hosts;
}

export function installEgressGuard(allowedHosts: readonly string[]): () => void {
  const allowed = new Set(allowedHosts);
  // Synchronous, and always run BEFORE the original is called, so no socket can open for a refused host.
  const verify = (hosts: string[]) => {
    if (!hosts.some((h) => h !== '' && allowed.has(h))) {
      throw new LabIsolationError(`lab: egress to ${hosts[0] || '<unknown>'} refused`);
    }
  };
  const origFetch = globalThis.fetch;
  const origHttp = http.request;
  const origHttps = https.request;
  const origHttpGet = http.get;
  const origHttpsGet = https.get;
  const guardedFetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const { url, hosts } = fetchTarget(input);
    verify(hosts);
    if (init && (init as Record<string, unknown>).dispatcher !== undefined) {
      throw new LabIsolationError('lab: egress option "dispatcher" refused');
    }
    // Pass the string we checked, not the caller's object (which could stringify differently twice).
    return origFetch(input instanceof Request ? input : url, init);
  }) as typeof fetch;
  globalThis.fetch = guardedFetch;
  const wrap = <F extends (...a: never[]) => unknown>(orig: F): F =>
    ((...args: Parameters<F>) => {
      verify(requestHosts(args));
      return orig(...args);
    }) as unknown as F;
  const gHttp = wrap(origHttp);
  const gHttps = wrap(origHttps);
  const gHttpGet = wrap(origHttpGet);
  const gHttpsGet = wrap(origHttpsGet);
  http.request = gHttp;
  https.request = gHttps;
  http.get = gHttpGet;
  https.get = gHttpsGet;
  syncBuiltinESMExports();
  let restored = false;
  return () => {
    if (restored) return;
    if (
      globalThis.fetch !== guardedFetch ||
      http.request !== gHttp ||
      https.request !== gHttps ||
      http.get !== gHttpGet ||
      https.get !== gHttpsGet
    ) {
      throw new LabIsolationError('egress guard exited out of order');
    }
    restored = true;
    globalThis.fetch = origFetch;
    http.request = origHttp;
    https.request = origHttps;
    http.get = origHttpGet;
    https.get = origHttpsGet;
    syncBuiltinESMExports();
  };
}

export function assertLabModels(models: ModelsConfig): void {
  for (const [role, cfg] of Object.entries(models.roles ?? {})) {
    for (const provider of [cfg?.provider, cfg?.fallback?.provider]) {
      if (provider && !LAB_ALLOWED_PROVIDERS.includes(provider)) {
        throw new LabIsolationError(`lab: role ${role} uses forbidden provider ${provider}`);
      }
    }
  }
}
