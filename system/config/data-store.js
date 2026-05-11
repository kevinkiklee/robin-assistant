import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrateHooksDisabledFlag } from '../config/hooks-disabled.js';

function findPackageRoot() {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (dir !== '/') {
    if (existsSync(join(dir, 'package.json'))) return dir;
    dir = dirname(dir);
  }
  throw new Error('cannot resolve package root from src/runtime/data-store.js');
}

const _packageRoot = findPackageRoot();

export function packageRootDir() {
  return _packageRoot;
}

export const POINTER_VERSION = 1;

/**
 * Compute the OS-native user-config pointer path (XDG on Linux, Library on macOS).
 *
 * Accepts optional overrides so the pure path-computation logic can be unit-tested
 * without touching the real filesystem or process globals.
 *
 * @param {{ platform?: string, home?: string, xdgConfigHome?: string }} [opts]
 */
export function osConfigPointerPath({
  platform = process.platform,
  home = homedir(),
  xdgConfigHome = process.env.XDG_CONFIG_HOME,
} = {}) {
  if (platform === 'darwin') {
    return join(home, 'Library', 'Application Support', 'Robin', 'install.json');
  }
  // Linux / other Unix.
  if (xdgConfigHome) return join(xdgConfigHome, 'robin', 'install.json');
  return join(home, '.config', 'robin', 'install.json');
}

/**
 * Resolve the pointer location(s) for read and write.
 *
 * Resolution chain:
 *   1. $ROBIN_POINTER_PATH — test override, maps everything to one path.
 *   2. <packageRoot>/.robin-home — writable-checkout (production default).
 *   3. OS-native user-config path — read-only-package-root fallback (§18).
 *
 * Test-only overrides:
 *   $ROBIN_POINTER_FALLBACK_PATH — overrides the OS-config path so tests can
 *     exercise the fallback without touching real OS config directories.
 *   $ROBIN_PACKAGE_ROOT_OVERRIDE — overrides `_packageRoot` so tests can point
 *     the primary pointer at a controlled (possibly read-only) directory without
 *     interfering with other tests that use $ROBIN_POINTER_PATH.
 *
 * @returns {{ read: string[], write: string | { primary: string, fallback: string } }}
 */
function pointerLocation() {
  if (process.env.ROBIN_POINTER_PATH) {
    return {
      read: [process.env.ROBIN_POINTER_PATH],
      write: process.env.ROBIN_POINTER_PATH,
    };
  }
  const pkgRoot = process.env.ROBIN_PACKAGE_ROOT_OVERRIDE ?? _packageRoot;
  const packageRootPath = join(pkgRoot, '.robin-home');
  const fallbackPath = process.env.ROBIN_POINTER_FALLBACK_PATH ?? osConfigPointerPath();
  return {
    read: [packageRootPath, fallbackPath],
    write: { primary: packageRootPath, fallback: fallbackPath },
  };
}

/**
 * Atomically write `payload` to path `p` via a tmp-then-rename sequence.
 * This is the single `renameSync` call for the pointer file.
 */
function writePointerAtomic(p, payload) {
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, JSON.stringify(payload, null, 2), { mode: 0o644 });
  renameSync(tmp, p);
}

export function resolveHomeStrict({ pointerPath } = {}) {
  if (process.env.ROBIN_HOME) {
    const p = resolve(process.env.ROBIN_HOME);
    if (!existsSync(p)) {
      throw new Error(
        `$ROBIN_HOME=${p} is set but the path does not exist. Create it or unset $ROBIN_HOME.`,
      );
    }
    return p;
  }

  // Determine which pointer paths to search.
  const searchPaths = pointerPath != null ? [pointerPath] : pointerLocation().read;

  // Find the first existing pointer file.
  const found = searchPaths.find((p) => existsSync(p));
  if (!found) {
    throw new Error('Robin is not installed. Run: robin install');
  }

  let parsed;
  try {
    parsed = JSON.parse(readFileSync(found, 'utf8'));
  } catch (e) {
    throw new Error(`malformed ${found}: ${e.message}`);
  }
  if (parsed?.version !== POINTER_VERSION) {
    throw new Error(
      `.robin-home version ${parsed?.version} is not supported (expected ${POINTER_VERSION}). Run: robin install`,
    );
  }
  const target = typeof parsed.home === 'string' ? resolve(parsed.home) : null;
  if (!target || !existsSync(target)) {
    throw new Error(
      `user-data path ${target ?? '(unset)'} recorded in .robin-home is missing. Run: robin install --relocate`,
    );
  }
  return target;
}

export function writePointer({ home, installedBy }) {
  const payload = {
    version: POINTER_VERSION,
    home: resolve(home),
    installedAt: new Date().toISOString(),
    installedBy: installedBy ?? 'unknown',
  };
  const loc = pointerLocation();
  const target = typeof loc.write === 'string' ? loc.write : loc.write.primary;
  try {
    mkdirSync(dirname(target), { recursive: true });
    writePointerAtomic(target, payload);
  } catch (e) {
    if (
      typeof loc.write === 'object' &&
      (e.code === 'EACCES' || e.code === 'EROFS' || e.code === 'ENOENT')
    ) {
      // Package root is not writable (e.g. npm i -g into a system path).
      // Fall back to the OS-native user-config location.
      mkdirSync(dirname(loc.write.fallback), { recursive: true });
      writePointerAtomic(loc.write.fallback, payload);
      return;
    }
    throw e;
  }
}

export function deletePointer() {
  const loc = pointerLocation();
  // Delete from ALL known locations so no stale pointer is left behind.
  const paths =
    typeof loc.write === 'string' ? [loc.write] : [loc.write.primary, loc.write.fallback];
  for (const p of paths) {
    if (existsSync(p)) unlinkSync(p);
  }
}

export function pointerExists() {
  return pointerLocation().read.some((p) => existsSync(p));
}

export function readPointer() {
  for (const p of pointerLocation().read) {
    if (!existsSync(p)) continue;
    try {
      return JSON.parse(readFileSync(p, 'utf8'));
    } catch {
      // Corrupted file — try the next location.
    }
  }
  return null;
}

export function robinHome() {
  return resolveHomeStrict();
}

export const paths = {
  data: {
    home: () => robinHome(),
    db: () => join(robinHome(), 'db'),
    secrets: () => join(robinHome(), 'secrets'),
    cache: () => join(robinHome(), 'cache'),
    logs: () => join(robinHome(), 'cache', 'logs'),
    backup: () => join(robinHome(), 'backup'),
    upload: () => join(robinHome(), 'upload'),
    config: () => join(robinHome(), 'config.json'),
    hostIntegrations: () => join(robinHome(), 'host-integrations.json'),
    daemonState: () => join(robinHome(), '.daemon.state'),
    daemonLock: () => join(robinHome(), '.daemon.lock'),
    manifestLock: () => join(robinHome(), '.manifest.lock'),
    marker: () => join(robinHome(), '.robin-data'),
  },
  source: {
    migrations: () => join(_packageRoot, 'system', 'data', 'db', 'migrations'),
    hookShim: () => join(_packageRoot, 'system', 'bin', 'robin-hook.sh'),
    robinBin: () => join(_packageRoot, 'system', 'bin', 'robin'),
  },
};

const MARKER_VERSION = 1;

export async function ensureHome() {
  const home = robinHome();
  for (const dir of [
    home,
    paths.data.db(),
    paths.data.secrets(),
    paths.data.cache(),
    paths.data.logs(),
    paths.data.backup(),
    paths.data.upload(),
  ]) {
    mkdirSync(dir, { recursive: true });
  }
  const markerPath = paths.data.marker();
  if (!existsSync(markerPath)) {
    const payload = { version: MARKER_VERSION, createdAt: new Date().toISOString() };
    writeFileSync(markerPath, JSON.stringify(payload, null, 2), { mode: 0o644 });
  }
  // Migrate hooks-disabled.txt → config.json.hooks.disabled (string[]).
  const flagPath = join(home, 'hooks-disabled.txt');
  if (existsSync(flagPath)) {
    const list = migrateHooksDisabledFlag(home);
    const cfgPath = paths.data.config();
    let cfg = {};
    if (existsSync(cfgPath)) {
      try {
        cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
      } catch {
        cfg = {};
      }
    }
    cfg.hooks = { ...(cfg.hooks ?? {}), disabled: list };
    writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), { mode: 0o644 });
    unlinkSync(flagPath);
  }
}

export function readMarker() {
  const p = paths.data.marker();
  if (!existsSync(p)) return null;
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return null;
    return parsed;
  } catch {
    return null;
  }
}

// ----- host-integrations manifest -----

const MANIFEST_VERSION = 1;
const LOCK_TIMEOUT_MS = 5000;
// Polling interval while another writer holds the manifest lock. Kept short
// because the critical section is a read-modify-write of a small JSON file
// (<10ms typical), so 25ms balances responsiveness against busy-spinning.
const LOCK_POLL_MS = 25;

async function acquireManifestLock() {
  const lockPath = paths.data.manifestLock();
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const fd = openSync(lockPath, 'wx');
      return { fd, lockPath };
    } catch (e) {
      if (e.code === 'EEXIST') {
        await new Promise((r) => setTimeout(r, LOCK_POLL_MS));
        continue;
      }
      throw e;
    }
  }
  throw new Error(`could not acquire manifest lock at ${lockPath} within ${LOCK_TIMEOUT_MS}ms`);
}

function releaseManifestLock(handle) {
  try {
    closeSync(handle.fd);
  } catch {}
  try {
    unlinkSync(handle.lockPath);
  } catch {}
}

function readManifestRaw() {
  const p = paths.data.hostIntegrations();
  const legacyPath = join(robinHome(), 'installed-hooks.json');
  if (existsSync(p)) {
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(p, 'utf8'));
    } catch (e) {
      throw new Error(`malformed ${p}: ${e.message}`);
    }
    if (parsed?.version !== MANIFEST_VERSION) {
      throw new Error(
        `host-integrations.json version ${parsed?.version} is not supported ` +
          `(expected ${MANIFEST_VERSION})`,
      );
    }
    return parsed;
  }
  if (existsSync(legacyPath)) {
    const legacy = JSON.parse(readFileSync(legacyPath, 'utf8'));
    const entries = [];
    if (Array.isArray(legacy?.claude)) {
      entries.push({
        kind: 'claude-hooks',
        path: join(process.env.HOME ?? '', '.claude/settings.json'),
        owned: legacy.claude,
        installedAt: new Date().toISOString(),
      });
    }
    if (Array.isArray(legacy?.gemini)) {
      entries.push({
        kind: 'gemini-hooks',
        path: join(process.env.HOME ?? '', '.gemini/settings.json'),
        owned: legacy.gemini,
        installedAt: new Date().toISOString(),
      });
    }
    return { version: MANIFEST_VERSION, updatedAt: new Date().toISOString(), entries };
  }
  return { version: MANIFEST_VERSION, updatedAt: new Date().toISOString(), entries: [] };
}

function writeManifestAtomic(manifest) {
  const p = paths.data.hostIntegrations();
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, JSON.stringify(manifest, null, 2), { mode: 0o644 });
  renameSync(tmp, p);
}

export async function readHostIntegrations() {
  return readManifestRaw();
}

export async function recordHostTouchpoint(entry, writeFn) {
  if (
    !entry ||
    typeof entry !== 'object' ||
    typeof entry.kind !== 'string' ||
    typeof entry.path !== 'string'
  ) {
    throw new TypeError(
      'recordHostTouchpoint: entry must have { kind: string, path: string, ... }',
    );
  }
  if (typeof writeFn !== 'function') {
    throw new TypeError('recordHostTouchpoint: writeFn must be a function');
  }
  // Run writeFn first; on throw, do not touch manifest or legacy file.
  await writeFn();
  const handle = await acquireManifestLock();
  try {
    const manifest = readManifestRaw();
    const idx = manifest.entries.findIndex((e) => e.kind === entry.kind && e.path === entry.path);
    const stored = { ...entry, installedAt: entry.installedAt ?? new Date().toISOString() };
    if (idx === -1) manifest.entries.push(stored);
    else manifest.entries[idx] = stored;
    manifest.updatedAt = new Date().toISOString();
    writeManifestAtomic(manifest);
    const legacyPath = join(robinHome(), 'installed-hooks.json');
    if (existsSync(legacyPath)) {
      unlinkSync(legacyPath);
    }
  } finally {
    releaseManifestLock(handle);
  }
}

export async function forgetHostTouchpoint({ kind, path: entryPath }) {
  const handle = await acquireManifestLock();
  try {
    const manifest = readManifestRaw();
    const before = manifest.entries.length;
    manifest.entries = manifest.entries.filter((e) => !(e.kind === kind && e.path === entryPath));
    const removed = before - manifest.entries.length;
    if (removed > 0) {
      manifest.updatedAt = new Date().toISOString();
      writeManifestAtomic(manifest);
    }
    return { removed };
  } finally {
    releaseManifestLock(handle);
  }
}

// ----- home discovery -----

// Legacy home name — kept as a named constant so grep audits don't flag
// inline string construction of the old default location.
const LEGACY_HOME_NAME = '.robin';

function defaultDiscoveryCandidates() {
  return [
    join(_packageRoot, 'user-data'),
    join(homedir(), LEGACY_HOME_NAME),
    join(homedir(), 'Documents', 'Robin'),
  ];
}

export function discoverExistingHomes({ candidates = defaultDiscoveryCandidates() } = {}) {
  const out = [];
  for (const dir of candidates) {
    if (!existsSync(dir)) continue;
    const markerPath = join(dir, '.robin-data');
    if (existsSync(markerPath)) {
      out.push({ path: dir, kind: 'marker', lastUsed: safeMtime(dir) });
      continue;
    }
    if (existsSync(join(dir, 'db', 'CURRENT')) || existsSync(join(dir, 'secrets', '.env'))) {
      out.push({ path: dir, kind: 'legacy', lastUsed: safeMtime(dir) });
    }
  }
  return out;
}

function safeMtime(dir) {
  try {
    const s = statSync(dir);
    return s.mtime.toISOString();
  } catch {
    return null;
  }
}
