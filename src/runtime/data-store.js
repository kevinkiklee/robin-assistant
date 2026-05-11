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

function pointerFilePath() {
  return join(_packageRoot, '.robin-home');
}

export function resolveHomeStrict({ pointerPath = pointerFilePath() } = {}) {
  if (process.env.ROBIN_HOME) {
    const p = resolve(process.env.ROBIN_HOME);
    if (!existsSync(p)) {
      throw new Error(
        `$ROBIN_HOME=${p} is set but the path does not exist. Create it or unset $ROBIN_HOME.`,
      );
    }
    return p;
  }
  if (!existsSync(pointerPath)) {
    throw new Error('Robin is not installed. Run: robin install');
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(pointerPath, 'utf8'));
  } catch (e) {
    throw new Error(`malformed ${pointerPath}: ${e.message}`);
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
  const p = pointerFilePath();
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, JSON.stringify(payload, null, 2), { mode: 0o644 });
  renameSync(tmp, p);
}

export function deletePointer() {
  const p = pointerFilePath();
  if (existsSync(p)) unlinkSync(p);
}

export function pointerExists() {
  return existsSync(pointerFilePath());
}

export function readPointer() {
  const p = pointerFilePath();
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

export function robinHome() {
  // LEGACY: this fallback is removed in Task 12.1 once install writes .robin-home.
  // Keeping it here so the test suite (which calls into commands that need a
  // home) keeps working while we layer in the new pieces.
  try {
    return resolveHomeStrict();
  } catch {
    if (process.env.ROBIN_HOME) return resolve(process.env.ROBIN_HOME);
    return join(_packageRoot, 'user-data');
  }
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
    migrations: () => join(_packageRoot, 'src', 'schema', 'migrations'),
    hookShim: () => join(_packageRoot, 'bin', 'robin-hook.sh'),
    robinBin: () => join(_packageRoot, 'bin', 'robin'),
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
  // Migrate hooks-disabled.txt → config.json.hooks.disabled.
  const flagPath = join(home, 'hooks-disabled.txt');
  if (existsSync(flagPath)) {
    const cfgPath = paths.data.config();
    let cfg = {};
    if (existsSync(cfgPath)) {
      try {
        cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
      } catch {
        cfg = {};
      }
    }
    cfg.hooks = { ...(cfg.hooks ?? {}), disabled: true };
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

async function acquireManifestLock() {
  const lockPath = paths.data.manifestLock();
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const fd = openSync(lockPath, 'wx');
      return { fd, lockPath };
    } catch (e) {
      if (e.code === 'EEXIST') {
        await new Promise((r) => setTimeout(r, 25));
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

function defaultDiscoveryCandidates() {
  return [
    join(_packageRoot, 'user-data'),
    join(homedir(), '.robin'),
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
