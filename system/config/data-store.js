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
import { migrateUserDataLayout } from '../runtime/install/layout-migrator.js';

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
  // Honors $ROBIN_PACKAGE_ROOT_OVERRIDE so unit tests can redirect
  // package-root-relative paths (e.g. .mcp.json) to a tempdir without
  // disturbing the real repo. Symmetric with how pointerLocation() reads
  // the same env var.
  return process.env.ROBIN_PACKAGE_ROOT_OVERRIDE ?? _packageRoot;
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
  if (typeof loc.write === 'string') {
    mkdirSync(dirname(loc.write), { recursive: true });
    writePointerAtomic(loc.write, payload);
    return;
  }
  // Write BOTH pointer locations when both are writable. install.pointer_present
  // invariant treats divergence as a failure; a single-location write leaves
  // the system one delete away from "Robin is not installed" because the
  // fallback was never populated. Writing both creates the redundancy the
  // runbook assumes already exists.
  let primaryWrote = false;
  try {
    mkdirSync(dirname(loc.write.primary), { recursive: true });
    writePointerAtomic(loc.write.primary, payload);
    primaryWrote = true;
  } catch (e) {
    if (e.code !== 'EACCES' && e.code !== 'EROFS' && e.code !== 'ENOENT') throw e;
    // Primary is read-only (e.g. npm i -g into a system path). Fall through.
  }
  try {
    mkdirSync(dirname(loc.write.fallback), { recursive: true });
    writePointerAtomic(loc.write.fallback, payload);
  } catch (e) {
    if (primaryWrote) return; // Primary succeeded; fallback failure is non-fatal.
    throw e; // Both failed.
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

/**
 * Public view of the pointer search paths — exposed for the invariants
 * framework so `install.pointer_present` can inspect both locations.
 */
export function pointerSearchPaths() {
  return [...pointerLocation().read];
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

// Faculty-aligned v2 layout. The realm directory (cognition/io/data/runtime)
// a path lives under tells you which faculty in `system/` owns the producer.
// See docs/superpowers/specs/2026-05-12-user-data-folder-redesign-design.md.
export const paths = {
  data: {
    home: () => robinHome(),

    // User-content surfaces (top-level for visibility).
    artifacts: () => join(robinHome(), 'artifacts'),
    jobs: () => join(robinHome(), 'jobs'),
    skills: () => join(robinHome(), 'skills'),
    sources: () => join(robinHome(), 'sources'),
    upload: () => join(robinHome(), 'upload'),

    // Config realm.
    config: () => join(robinHome(), 'config', 'config.json'),
    secrets: () => join(robinHome(), 'config', 'secrets'),

    // Cognition realm.
    reinforcementLastRun: () => join(robinHome(), 'cognition', 'reinforcement-last-run.json'),

    // Io realm.
    publishIndex: () => join(robinHome(), 'io', 'publish', 'index.jsonl'),
    sqliteSnapshots: () => join(robinHome(), 'io', 'sqlite-snapshots'),

    // Data realm.
    db: () => join(robinHome(), 'data', 'db'),
    // Robin-DB pre-migration backups (distinct from io/sqlite-snapshots,
    // which caches external sqlite DBs for io integrations).
    snapshots: () => join(robinHome(), 'data', 'snapshots'),

    // Runtime realm.
    logs: () => join(robinHome(), 'runtime', 'logs'),
    daemonPid: () => join(robinHome(), 'runtime', 'daemon', '.pid'),
    daemonState: () => join(robinHome(), 'runtime', 'daemon', '.state'),
    mcpToken: () => join(robinHome(), 'runtime', 'mcp-token'),
    // `.daemon.lock` is the *embedded-DB writer-serialization* lock, held
    // briefly by CLI subcommands (biographer, dream, ingest, etc.) that
    // open the local store directly. It is NOT the daemon's process-
    // singleton lock — `.daemon.pid` above owns that. Keeping the two
    // separate lets the daemon start while a long-running CLI subcommand
    // (e.g. biographer flushing through an LLM call) is mid-flight.
    daemonLock: () => join(robinHome(), 'runtime', 'daemon', '.lock'),
    manifest: () => join(robinHome(), 'runtime', 'install', 'manifest.json'),
    manifestLock: () => join(robinHome(), 'runtime', 'install', '.manifest.lock'),
    hostIntegrations: () => join(robinHome(), 'runtime', 'install', 'host-integrations.json'),
    marker: () => join(robinHome(), 'runtime', 'install', '.marker.json'),
    installReports: () => join(robinHome(), 'runtime', 'install', 'reports'),

    // Invariants framework (defensive operational reliability layer).
    invariantsState: () => join(robinHome(), 'runtime', 'invariants-state.json'),
    invariantsLocks: () => join(robinHome(), 'runtime', 'locks', 'invariants'),
    divergenceLog: () => join(robinHome(), 'runtime', 'divergence_log.json'),
    healthAlert: () => join(robinHome(), 'runtime', 'HEALTH_ALERT.md'),
  },
  source: {
    migrations: () => join(_packageRoot, 'system', 'data', 'db', 'migrations'),
    hookShim: () => join(_packageRoot, 'system', 'bin', 'robin-hook.sh'),
    robinBin: () => join(_packageRoot, 'system', 'bin', 'robin'),
  },
};

const MARKER_VERSION_V2 = 2;

function ensureMarker(home) {
  const newMarker = paths.data.marker();
  if (existsSync(newMarker)) return;
  // Preserve createdAt from the legacy marker if it's still around (e.g. the
  // migrator wrote the new marker but failed to unlink the old one). Falls
  // back to "now" on a fresh install.
  let createdAt = new Date().toISOString();
  const oldMarker = join(home, '.robin-data');
  if (existsSync(oldMarker)) {
    try {
      const legacy = JSON.parse(readFileSync(oldMarker, 'utf8'));
      if (typeof legacy?.createdAt === 'string') createdAt = legacy.createdAt;
    } catch {}
    try {
      unlinkSync(oldMarker);
    } catch {}
  }
  mkdirSync(dirname(newMarker), { recursive: true });
  writeFileSync(
    newMarker,
    JSON.stringify({ user_data_layout_version: MARKER_VERSION_V2, createdAt }, null, 2),
    { mode: 0o644 },
  );
}

export async function ensureHome() {
  const home = robinHome();
  mkdirSync(home, { recursive: true });

  // Step 1: migrate v1→v2 layout if needed. No-op once already v2 or fresh.
  // Must run BEFORE mkdir below, because pre-creating the new dirs causes
  // rename-onto-empty-dir to fail on macOS (and behave nondeterministically
  // on Linux). The migrator throws LAYOUT_MIGRATOR_DAEMON_RUNNING if the
  // daemon is alive during a v1→v2 transition.
  await migrateUserDataLayout(home);

  // Step 2: ensure the v2 directory set exists.
  for (const dir of [
    paths.data.artifacts(),
    paths.data.jobs(),
    paths.data.skills(),
    paths.data.sources(),
    paths.data.upload(),
    dirname(paths.data.config()), // config/
    paths.data.secrets(), // config/secrets/
    dirname(paths.data.reinforcementLastRun()), // cognition/
    dirname(paths.data.publishIndex()), // io/publish/
    paths.data.sqliteSnapshots(),
    paths.data.db(),
    paths.data.snapshots(),
    paths.data.logs(),
    dirname(paths.data.daemonPid()), // runtime/daemon/
    dirname(paths.data.manifest()), // runtime/install/
    paths.data.installReports(),
  ]) {
    mkdirSync(dir, { recursive: true });
  }

  // Step 3: marker — write the v2 marker on a fresh install (no-op if the
  // migrator already wrote it).
  ensureMarker(home);

  // Step 4: legacy hooks-disabled.txt → config.json.hooks.disabled migration.
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
    mkdirSync(dirname(cfgPath), { recursive: true });
    writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), { mode: 0o644 });
    unlinkSync(flagPath);
  }
}

export function readMarker() {
  // Prefer the v2 marker.
  const newP = paths.data.marker();
  if (existsSync(newP)) {
    try {
      const parsed = JSON.parse(readFileSync(newP, 'utf8'));
      if (typeof parsed === 'object' && parsed !== null) return parsed;
    } catch {}
  }
  // Fall back to the legacy marker (only relevant between migration steps or
  // on a never-touched home).
  const oldP = join(robinHome(), '.robin-data');
  if (!existsSync(oldP)) return null;
  try {
    const parsed = JSON.parse(readFileSync(oldP, 'utf8'));
    return typeof parsed === 'object' && parsed !== null ? parsed : null;
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
    const newMarker = join(dir, 'runtime', 'install', '.marker.json');
    const oldMarker = join(dir, '.robin-data');
    if (existsSync(newMarker) || existsSync(oldMarker)) {
      out.push({ path: dir, kind: 'marker', lastUsed: safeMtime(dir) });
      continue;
    }
    // Legacy-shape detection: probe v2 and v1 storage locations alike.
    if (
      existsSync(join(dir, 'data', 'db', 'CURRENT')) ||
      existsSync(join(dir, 'db', 'CURRENT')) ||
      existsSync(join(dir, 'config', 'secrets', '.env')) ||
      existsSync(join(dir, 'secrets', '.env'))
    ) {
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

/**
 * Non-throwing variant of `robinHome()`. Returns the configured user-data home
 * if one is resolvable, or `null` if Robin is not yet installed (no pointer
 * file, no `$ROBIN_HOME`). Used by callers that need to *probe* for user-data
 * without forcing the "Robin is not installed" error path — e.g. the
 * integration loader, which falls back to system-only on fresh installs.
 *
 * Honors the same precedence as `resolveHomeStrict()`:
 *   1. `$ROBIN_HOME` (must point at an existing directory)
 *   2. Pointer file (`<packageRoot>/.robin-home` or OS-config fallback)
 *
 * @returns {string | null}
 */
function readHomeFromPointer() {
  if (process.env.ROBIN_HOME) {
    const p = resolve(process.env.ROBIN_HOME);
    return existsSync(p) ? p : null;
  }
  const ptr = readPointer();
  if (!ptr || ptr.version !== POINTER_VERSION || typeof ptr.home !== 'string') return null;
  const target = resolve(ptr.home);
  return existsSync(target) ? target : null;
}

/**
 * Returns the ordered list of directories the integration loader should scan.
 *
 * Always includes the system integrations dir (`system/io/integrations`).
 * Includes the user-data integrations dir (`<home>/io/integrations`) only if
 * it exists on disk — fresh installs without user-data won't see a missing-dir
 * warning from the loader.
 *
 * Order matters: system entries are loaded first, then user-data entries can
 * shadow or extend them.
 *
 * @returns {string[]}
 */
export function getIntegrationDirs() {
  const systemDir = join(packageRootDir(), 'system', 'io', 'integrations');
  const home = readHomeFromPointer();
  if (!home) return [systemDir];
  const userDir = join(home, 'io', 'integrations');
  if (!existsSync(userDir)) return [systemDir];
  return [systemDir, userDir];
}
