// Tamper-detection manifest. Captures hashes of key handler files,
// permissions of sensitive paths, and the supervisor (launchd/systemd) file.
//
// Written by `robin install` (and `robin embedder switch`, `robin doctor
// --rebaseline`) to <robinHome>/manifest.json. Read by daemon-boot
// tamper-check (src/daemon/tamper-check.js) to surface drift.

import { existsSync, readFileSync } from 'node:fs';
import { chmod, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { sha256 } from '../embed/hash.js';
import { packageRootDir, paths } from '../runtime/data-store.js';

// Files whose contents should be pinned. Paths relative to the package root.
// Files that don't exist at compute time are silently omitted from the manifest.
const TRACKED_FILES = [
  'bin/robin',
  'bin/robin-hook.sh',
  'src/hooks/cli.js',
  'src/daemon/server.js',
  'src/capture/record-event.js',
  'src/mcp/tools/remember.js',
  'src/mcp/tools/record-correction.js',
];

function readPackageVersion(packageRoot) {
  const pkgPath = join(packageRoot, 'package.json');
  const raw = readFileSync(pkgPath, 'utf8');
  const pkg = JSON.parse(raw);
  return pkg.version;
}

function modeString(mode) {
  // POSIX permission bits as zero-padded octal, e.g. 0o600 -> "0600".
  // mode comes from fs.stat as a number; mask to permission bits only.
  return `0${(mode & 0o777).toString(8).padStart(3, '0')}`;
}

async function modeFor(path) {
  if (!existsSync(path)) return null;
  const st = await stat(path);
  return modeString(st.mode);
}

function supervisorPath() {
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'LaunchAgents', 'io.robin-assistant.mcp.plist');
  }
  if (process.platform === 'linux') {
    return join(homedir(), '.config', 'systemd', 'user', 'robin-mcp.service');
  }
  return null;
}

async function hashFileIfExists(absPath) {
  if (!existsSync(absPath)) return null;
  const buf = await readFile(absPath, 'utf8');
  return sha256(buf);
}

export async function computeManifest(opts = {}) {
  const includeSupervisor = opts.includeSupervisor !== false;
  const root = packageRootDir();

  const files = [];
  for (const rel of TRACKED_FILES) {
    const abs = join(root, rel);
    const hash = await hashFileIfExists(abs);
    if (hash !== null) files.push({ path: rel, sha256: hash });
  }

  const secretsEnv = join(paths.data.secrets(), '.env');
  const perms = {
    secrets_env_mode: await modeFor(secretsEnv),
    db_dir_mode: await modeFor(paths.data.db()),
  };

  let supervisor = null;
  if (includeSupervisor) {
    const supPath = supervisorPath();
    if (supPath === null) {
      supervisor = { path: null, exists: false, sha256: null };
    } else {
      const exists = existsSync(supPath);
      const hash = exists ? await hashFileIfExists(supPath) : null;
      supervisor = { path: supPath, exists, sha256: hash };
    }
  }

  const manifest = {
    package_version: readPackageVersion(root),
    generated_at: new Date().toISOString(),
    files,
    perms,
  };
  if (includeSupervisor) manifest.supervisor = supervisor;
  return manifest;
}

function manifestPath() {
  return join(paths.data.home(), 'manifest.json');
}

export async function writeManifest(manifest) {
  const target = manifestPath();
  await mkdir(dirname(target), { recursive: true });
  const tmp = `${target}.tmp`;
  await writeFile(tmp, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });
  await rename(tmp, target);
  await chmod(target, 0o644);
}

export async function readManifest() {
  const target = manifestPath();
  if (!existsSync(target)) return null;
  try {
    const raw = await readFile(target, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export { manifestPath as _manifestPathForTests, supervisorPath as _supervisorPathForTests };
